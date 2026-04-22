/**
 * MQTT 服务：
 *  - 单进程内支持多连接（按 connectionId 复用 / 互不影响）
 *  - 入站消息批量推送到渲染进程（33ms / 400 条 / 队列硬上限 4000 + 优先主题保留）
 *  - 入站重叠订阅去重（20ms 内相同 topic+payload 视为同一条）
 */

import mqtt, { MqttClient, IClientOptions, IPublishPacket } from 'mqtt';
import type { BrowserWindow } from 'electron';
import type { ApiResult, ConnectPayload, MqttMessage, PublishPayload } from '../../shared/types';
import { enqueueMessage } from './storage';

interface ConnectionCtx {
    id: string;
    client: MqttClient;
    disabledTopics: Set<string>;
    priorityTopic: string | null;
    dedupe: Map<string, number>;
}

/**
 * 去重窗口：同一 (topic, payload) 在窗口内视为重复并丢弃。
 * - 2 秒足够覆盖 QoS1/2 的协议重传（一般 3-5 秒；结合 dup 标志兜底）
 * - 以及重叠订阅导致的多路投递（一般同帧/同百毫秒）
 * - 超过 2 秒的相同 payload 视为业务真实重复，放行
 */
const INBOUND_DEDUP_WINDOW_MS = 2000;
const DEDUPE_MAX_ENTRIES = 1024;
const IPC_FLUSH_MS = 33;
const IPC_BATCH_HARD = 800;
const IPC_QUEUE_HARD = 16000;

export class MqttService {
    private conns = new Map<string, ConnectionCtx>();
    private ipcQueue: MqttMessage[] = [];
    private ipcTimer: NodeJS.Timeout | null = null;
    private seq = 0;
    private getWin: () => BrowserWindow | null;

    constructor(getWin: () => BrowserWindow | null) {
        this.getWin = getWin;
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
                    priorityTopic: null,
                    dedupe: new Map()
                };
                this.conns.set(p.connectionId, ctx);

                // 硬超时：8 秒内没触发 connect 事件就视作失败，清理现场
                const hardTimeout = setTimeout(() => {
                    if (!settled) {
                        try { client.end(true); } catch {}
                        this.conns.delete(p.connectionId);
                        settle({ success: false, message: '连接超时' });
                    }
                }, 8000);

                let initialConnect = true;
                client.on('connect', () => {
                    ctx.dedupe.clear();
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
                    this.sendState(p.connectionId, 'closed');
                    if (initialConnect && !settled) {
                        // 首次还没连上就关闭（broker 拒绝 / 网络直接断）
                        clearTimeout(hardTimeout);
                        try { client.end(true); } catch {}
                        this.conns.delete(p.connectionId);
                        settle({ success: false, message: '连接被关闭' });
                    }
                });
                client.on('error', (err) => {
                    this.sendState(p.connectionId, 'error', err.message);
                    if (initialConnect && !settled) {
                        clearTimeout(hardTimeout);
                        try { client.end(true); } catch {}
                        this.conns.delete(p.connectionId);
                        settle({ success: false, message: err.message });
                    }
                });

            let msgCount = 0;
            let dupCount = 0;
            client.on('message', (topic, payload, packet?: IPublishPacket) => {
                // 1) QoS1/2 协议级重传：broker 没收到 PUBACK 就会再发一次，dup=true
                //    mqtt.js 已自动回 ACK，我们在应用层直接丢弃
                if (packet && packet.dup) { dupCount++; return; }

                if (ctx.disabledTopics.has(topic)) return;
                const text = payload.toString('utf8');
                const now = Date.now();

                // 2) 业务层去重：LRU Map，窗口 2s 内相同 (topic, payload) 丢弃
                const key = `${topic}\n${text}`;
                const last = ctx.dedupe.get(key);
                if (last !== undefined && now - last < INBOUND_DEDUP_WINDOW_MS) {
                    dupCount++;
                    return;
                }
                ctx.dedupe.set(key, now);
                if (ctx.dedupe.size > DEDUPE_MAX_ENTRIES) {
                    // 淘汰最旧的
                    const firstKey = ctx.dedupe.keys().next().value;
                    if (firstKey !== undefined) ctx.dedupe.delete(firstKey);
                }

                enqueueMessage(p.connectionId, topic, text, now);
                this.enqueueIpc({ topic, payload: text, time: now, seq: ++this.seq }, ctx);
                if (++msgCount <= 3 || msgCount % 500 === 0) {
                    console.log(`[mqtt][${p.connectionId}] msg #${msgCount} (dup filtered: ${dupCount}) ${topic} (${text.length}B)`);
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
            try { ctx.client.removeAllListeners(); } catch {}
            try { ctx.client.end(true); } catch {}
            this.conns.delete(connectionId);
        }
        return { success: true };
    }

    subscribe(connectionId: string, topic: string, qos: 0 | 1 | 2): Promise<ApiResult> {
        const ctx = this.conns.get(connectionId);
        if (!ctx || !ctx.client.connected) return Promise.resolve({ success: false, message: '未连接' });
        const normalized = topic.trim().replace(/\uFF0B/g, '+');
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
        const normalized = topic.trim().replace(/\uFF0B/g, '+');
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
        const c = this.conns.get(connectionId);
        if (c) c.priorityTopic = topic;
    }

    // ---------- IPC batching ----------
    private enqueueIpc(msg: MqttMessage, ctx: ConnectionCtx): void {
        this.ipcQueue.push(msg);
        if (this.ipcQueue.length > IPC_QUEUE_HARD) this.trimQueue(ctx.priorityTopic);
        if (this.ipcQueue.length >= IPC_BATCH_HARD) this.flushIpc();
        else this.scheduleFlush();
    }

    private trimQueue(priority: string | null): void {
        const excess = this.ipcQueue.length - IPC_QUEUE_HARD;
        if (excess <= 0) return;
        const mark = new Uint8Array(this.ipcQueue.length);
        let removed = 0;
        if (priority) {
            for (let i = 0; i < this.ipcQueue.length && removed < excess; i++) {
                if (this.ipcQueue[i].topic !== priority) { mark[i] = 1; removed++; }
            }
        }
        if (removed < excess) {
            for (let i = 0; i < this.ipcQueue.length && removed < excess; i++) {
                if (!mark[i]) { mark[i] = 1; removed++; }
            }
        }
        const kept = new Array<MqttMessage>(this.ipcQueue.length - removed);
        let k = 0;
        for (let i = 0; i < this.ipcQueue.length; i++) if (!mark[i]) kept[k++] = this.ipcQueue[i];
        this.ipcQueue = kept;
        console.warn(`[mqtt] IPC 队列积压超限，已降采样丢弃 ${removed} 条（priority=${priority ?? 'none'}）`);
    }

    private scheduleFlush(): void {
        if (this.ipcTimer) return;
        this.ipcTimer = setTimeout(() => { this.ipcTimer = null; this.flushIpc(); }, IPC_FLUSH_MS);
    }

    private flushIpc(): void {
        if (this.ipcTimer) { clearTimeout(this.ipcTimer); this.ipcTimer = null; }
        if (this.ipcQueue.length === 0) return;
        const win = this.getWin();
        if (!win || win.isDestroyed()) { this.ipcQueue.length = 0; return; }
        const batch = this.ipcQueue.splice(0, this.ipcQueue.length);
        try {
            win.webContents.send('mqtt:messages', batch);
        } catch (e) {
            console.error('[mqtt] send batch:', e);
        }
    }

    private sendState(connectionId: string, state: string, message?: string): void {
        const win = this.getWin();
        if (!win || win.isDestroyed()) return;
        win.webContents.send('mqtt:state', { connectionId, state, message });
    }

    flush(): void {
        this.flushIpc();
    }

    shutdown(): void {
        this.flushIpc();
        for (const id of [...this.conns.keys()]) this.disconnect(id);
    }
}
