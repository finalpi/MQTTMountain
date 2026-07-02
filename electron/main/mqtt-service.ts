/**
 * MQTT 服务：
 *  - 单进程内支持多连接（按 connectionId 复用 / 互不影响）
 *  - 入站消息批量推送到渲染进程（有界队列 / 分批 flush / 优先主题保留）
 */

import mqtt, { MqttClient, IClientOptions, IPublishPacket } from 'mqtt';
import type { BrowserWindow } from 'electron';
import type { ApiResult, ConnectPayload, MqttMessage, PublishPayload } from '../../shared/types';
import { MqttIpcQueue } from './mqtt-ipc-queue';
import { decodePayloadView } from './payload-codec';
import { enqueueMessage } from './storage';

interface ConnectionCtx {
    id: string;
    client: MqttClient;
    disabledTopics: Set<string>;
    closing: boolean;
}

export class MqttService {
    private conns = new Map<string, ConnectionCtx>();
    private ipcQueue: MqttIpcQueue;
    private seq = 0;
    private getWin: () => BrowserWindow | null;
    private shuttingDown = false;

    constructor(getWin: () => BrowserWindow | null) {
        this.getWin = getWin;
        this.ipcQueue = new MqttIpcQueue(getWin);
    }

    /**
     * 建立 MQTT 连接。返回 Promise，在 MQTT `connect` 事件真正触发后才 resolve
     * —— 否则调用方紧跟着发 subscribe 会因 `client.connected=false` 全部失败。
     */
    connect(p: ConnectPayload): Promise<ApiResult> {
        return new Promise((resolve) => {
            let settled = false;
            const settle = (r: ApiResult) => {
                if (settled) return;
                settled = true;
                resolve(r);
            };

            try {
                this.disconnect(p.connectionId);
                const url = (p.protocol === 'mqtt://' || p.protocol === 'mqtts://')
                    ? `${p.protocol}${p.host}:${p.port}`
                    : `${p.protocol}${p.host}:${p.port}${p.path || ''}`;
                const opts: IClientOptions = {
                    clientId: p.clientId,
                    clean: true,
                    connectTimeout: 5000,
                    reconnectPeriod: 4000,
                    protocolVersion: 4
                };
                if (p.username) opts.username = p.username;
                if (p.password) opts.password = p.password;

                const client = mqtt.connect(url, opts);
                const ctx: ConnectionCtx = {
                    id: p.connectionId,
                    client,
                    disabledTopics: new Set(p.disabledTopics || []),
                    closing: false
                };
                this.conns.set(p.connectionId, ctx);

                // 硬超时：8 秒内没触发 connect 事件就视作失败，清理现场
                const hardTimeout = setTimeout(() => {
                    if (!settled) {
                        try { client.end(true); } catch {}
                        this.conns.delete(p.connectionId);
                        this.ipcQueue.dropConnection(p.connectionId);
                        settle({ success: false, message: '连接超时' });
                    }
                }, 8000);

                let initialConnect = true;
                client.on('connect', () => {
                    this.sendState(p.connectionId, 'connected');
                    if (initialConnect) {
                        initialConnect = false;
                        clearTimeout(hardTimeout);
                        console.log(`[mqtt][${p.connectionId}] CONNECT OK ${url}`);
                        settle({ success: true });
                    } else {
                        console.log(`[mqtt][${p.connectionId}] RECONNECTED ${url}`);
                    }
                });
                client.on('reconnect', () => this.sendState(p.connectionId, 'reconnecting'));
                client.on('offline', () => this.sendState(p.connectionId, 'offline'));
                client.on('close', () => {
                    if (initialConnect && !settled) {
                        // 首次还没连上就关闭（broker 拒绝 / 网络直接断）
                        clearTimeout(hardTimeout);
                        try { client.end(true); } catch {}
                        this.conns.delete(p.connectionId);
                        this.ipcQueue.dropConnection(p.connectionId);
                        settle({ success: false, message: '连接被关闭' });
                        return;
                    }
                    if (ctx.closing) {
                        this.sendState(p.connectionId, 'closed');
                        return;
                    }
                    this.sendState(p.connectionId, 'reconnecting');
                });
                client.on('error', (err) => {
                    this.sendState(p.connectionId, 'error', err.message);
                    if (initialConnect && !settled) {
                        clearTimeout(hardTimeout);
                        try { client.end(true); } catch {}
                        this.conns.delete(p.connectionId);
                        this.ipcQueue.dropConnection(p.connectionId);
                        settle({ success: false, message: err.message });
                    }
                });

                let msgCount = 0;
                client.on('message', (topic, payload, _packet?: IPublishPacket) => {
                    if (this.shuttingDown || ctx.closing || ctx.disabledTopics.has(topic)) return;
                    const payloadView = decodePayloadView(payload);
                    const text = payloadView.text;
                    const now = Date.now();

                    enqueueMessage(p.connectionId, topic, text, now, {
                        payloadBytes: payload,
                        payloadSize: payloadView.size,
                        payloadEncoding: payloadView.encoding
                    });
                    const msg: MqttMessage = {
                        connectionId: p.connectionId,
                        topic,
                        payload: text,
                        payloadSize: payloadView.size,
                        payloadEncoding: payloadView.encoding,
                        time: now,
                        seq: ++this.seq
                    };
                    this.ipcQueue.enqueue(msg);
                    if (++msgCount <= 3 || msgCount % 500 === 0) {
                        console.log(`[mqtt][${p.connectionId}] msg #${msgCount} ${topic} (${text.length}B)`);
                    }
                });
            } catch (e) {
                settle({ success: false, message: (e as Error).message });
            }
        });
    }

    disconnect(connectionId: string): ApiResult {
        const ctx = this.conns.get(connectionId);
        if (ctx) {
            ctx.closing = true;
            try { ctx.client.removeAllListeners(); } catch {}
            try { ctx.client.end(true); } catch {}
            this.conns.delete(connectionId);
        }
        this.ipcQueue.dropConnection(connectionId);
        return { success: true };
    }

    subscribe(connectionId: string, topic: string, qos: 0 | 1 | 2): Promise<ApiResult> {
        const ctx = this.conns.get(connectionId);
        if (!ctx || !ctx.client.connected) return Promise.resolve({ success: false, message: '未连接' });
        const normalized = topic.trim().replace(/＋/g, '+');
        return new Promise((resolve) => {
            ctx.client.subscribe(normalized, { qos }, (err, granted) => {
                if (err) {
                    console.log(`[mqtt][${connectionId}] sub FAIL:`, normalized, err.message);
                    resolve({ success: false, message: err.message });
                } else {
                    console.log(`[mqtt][${connectionId}] sub OK:`, granted?.map((g) => `${g.topic}@qos${g.qos}`).join(','));
                    resolve({ success: true });
                }
            });
        });
    }

    unsubscribe(connectionId: string, topic: string): Promise<ApiResult> {
        const ctx = this.conns.get(connectionId);
        if (!ctx || !ctx.client.connected) return Promise.resolve({ success: false, message: '未连接' });
        const normalized = topic.trim().replace(/＋/g, '+');
        return new Promise((resolve) => {
            ctx.client.unsubscribe(normalized, (err) => {
                if (err) resolve({ success: false, message: err.message });
                else resolve({ success: true });
            });
        });
    }

    publish(connectionId: string, p: PublishPayload): Promise<ApiResult> {
        const ctx = this.conns.get(connectionId);
        if (!ctx || !ctx.client.connected) return Promise.resolve({ success: false, message: '未连接' });
        return new Promise((resolve) => {
            ctx.client.publish(p.topic, p.payload, { qos: p.qos, retain: p.retain }, (err) => {
                if (err) resolve({ success: false, message: err.message });
                else resolve({ success: true });
            });
        });
    }

    disableTopic(connectionId: string, topic: string): void {
        this.conns.get(connectionId)?.disabledTopics.add(topic);
    }
    enableTopic(connectionId: string, topic: string): void {
        this.conns.get(connectionId)?.disabledTopics.delete(topic);
    }
    setPriorityTopic(connectionId: string, topic: string | null): void {
        this.ipcQueue.setPriorityTopic(connectionId, topic);
    }

    setActiveConnection(connectionId: string | null): void {
        this.ipcQueue.setActiveConnection(connectionId || null);
    }

    setDisplayPaused(connectionId: string, paused: boolean): void {
        this.ipcQueue.setDisplayPaused(connectionId, paused);
    }

    private sendState(connectionId: string, state: string, message?: string): void {
        const win = this.getWin();
        if (!win || win.isDestroyed()) return;
        win.webContents.send('mqtt:state', { connectionId, state, message });
    }

    flush(): void {
        this.ipcQueue.flush();
    }

    shutdown(): void {
        this.shuttingDown = true;
        this.ipcQueue.flush();
        for (const id of [...this.conns.keys()]) this.disconnect(id);
        this.ipcQueue.shutdown();
    }
}
