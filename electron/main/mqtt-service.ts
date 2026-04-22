/**
 * MQTT 服务：
 *  - 单进程内支持多连接（按 connectionId 复用 / 互不影响）
 *  - 入站消息批量推送到渲染进程（33ms / 400 条 / 队列硬上限 4000 + 优先主题保留）
 *  - 入站重叠订阅去重（20ms 内相同 topic+payload 视为同一条）
 */

import mqtt, { MqttClient, IClientOptions } from 'mqtt';
import type { BrowserWindow } from 'electron';
import type { ApiResult, ConnectPayload, MqttMessage, PublishPayload } from '../../shared/types';
import { enqueueMessage } from './storage';

interface ConnectionCtx {
    id: string;
    client: MqttClient;
    disabledTopics: Set<string>;
    priorityTopic: string | null;
    lastDedupeKey: string;
    lastDedupeAt: number;
}

const INBOUND_DEDUP_WINDOW_MS = 20;
const IPC_FLUSH_MS = 33;
const IPC_BATCH_HARD = 400;
const IPC_QUEUE_HARD = 4000;

export class MqttService {
    private conns = new Map<string, ConnectionCtx>();
    private ipcQueue: MqttMessage[] = [];
    private ipcTimer: NodeJS.Timeout | null = null;
    private seq = 0;
    private getWin: () => BrowserWindow | null;

    constructor(getWin: () => BrowserWindow | null) {
        this.getWin = getWin;
    }

    connect(p: ConnectPayload): ApiResult {
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
                lastDedupeKey: '',
                lastDedupeAt: 0
            };
            this.conns.set(p.connectionId, ctx);

            client.on('connect', () => {
                ctx.lastDedupeKey = ''; ctx.lastDedupeAt = 0;
                this.sendState(p.connectionId, 'connected');
            });
            client.on('reconnect', () => this.sendState(p.connectionId, 'reconnecting'));
            client.on('offline', () => this.sendState(p.connectionId, 'offline'));
            client.on('close', () => this.sendState(p.connectionId, 'closed'));
            client.on('error', (err) => this.sendState(p.connectionId, 'error', err.message));

            let msgCount = 0;
            client.on('message', (topic, payload) => {
                if (ctx.disabledTopics.has(topic)) return;
                const text = payload.toString('utf8');
                const now = Date.now();
                const key = `${topic}\0${text}`;
                if (key === ctx.lastDedupeKey && now - ctx.lastDedupeAt < INBOUND_DEDUP_WINDOW_MS) return;
                ctx.lastDedupeKey = key;
                ctx.lastDedupeAt = now;
                enqueueMessage(p.connectionId, topic, text, now);
                this.enqueueIpc({ topic, payload: text, time: now, seq: ++this.seq }, ctx);
                if (++msgCount <= 3 || msgCount % 500 === 0) {
                    console.log(`[mqtt][${p.connectionId}] msg #${msgCount} ${topic} (${text.length}B)`);
                }
            });

            return { success: true };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
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
