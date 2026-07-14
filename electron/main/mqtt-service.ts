/**
 * MQTT 服务：
 *  - 单进程内支持多连接（按 connectionId 复用 / 互不影响）
 *  - 入站消息批量推送到渲染进程（有界队列 / 分批 flush / 优先主题保留）
 */

import mqtt, { MqttClient, IClientOptions, IPublishPacket } from 'mqtt';
import type { BrowserWindow } from 'electron';
import type { ApiResult, ConnectPayload, MqttMessage, PublishPayload } from '../../shared/types';
import { MqttIpcQueue } from './mqtt-ipc-queue';
import { writeDiagnosticLog } from './diagnostics';
import { decodePayloadView } from './payload-codec';
import {
    enqueueMessage,
    getStorageDiagnosticsAsync,
    isStorageBackpressured,
    setStoragePressureListener
} from './storage';

interface QueuedMqttMessage {
    ctx: ConnectionCtx;
    connectionId: string;
    topic: string;
    payload: Buffer;
}

interface ConnectionCtx {
    id: string;
    client: MqttClient;
    disabledTopics: Set<string>;
    closing: boolean;
    msgCount: number;
    droppedMessages: number;
}

const MESSAGE_PROCESS_INTERVAL_MS = 8;
const MESSAGE_PROCESS_BATCH = 1000;
const MESSAGE_PROCESS_QUEUE_HARD = 100_000;
const MQTT_OPERATION_TIMEOUT_MS = 10_000;

export class MqttService {
    private conns = new Map<string, ConnectionCtx>();
    private ipcQueue: MqttIpcQueue;
    private seq = 0;
    private getWin: () => BrowserWindow | null;
    private shuttingDown = false;
    private messageQueue: QueuedMqttMessage[] = [];
    private messageQueueHead = 0;
    private messageQueueTimer: NodeJS.Timeout | null = null;
    private diagnosticsTimer: NodeJS.Timeout | null = null;
    private storageBackpressured = false;
    private storageDiagnosticsInFlight = false;

    constructor(getWin: () => BrowserWindow | null) {
        this.getWin = getWin;
        this.ipcQueue = new MqttIpcQueue(getWin);
        setStoragePressureListener((pressured) => this.setStorageBackpressure(pressured));
        this.startDiagnostics();
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

                writeDiagnosticLog('[mqtt] connect request', {
                    connectionId: p.connectionId,
                    url,
                    clientId: p.clientId,
                    existingConnections: this.conns.size
                });
                const client = mqtt.connect(url, opts);
                const ctx: ConnectionCtx = {
                    id: p.connectionId,
                    client,
                    disabledTopics: new Set(p.disabledTopics || []),
                    closing: false,
                    msgCount: 0,
                    droppedMessages: 0
                };
                this.conns.set(p.connectionId, ctx);

                // 硬超时：8 秒内没触发 connect 事件就视作失败，清理现场
                const hardTimeout = setTimeout(() => {
                    if (!settled) {
                        ctx.closing = true;
                        try { client.end(true); } catch {}
                        if (this.conns.get(p.connectionId) === ctx) this.conns.delete(p.connectionId);
                        this.ipcQueue.dropConnection(p.connectionId);
                        settle({ success: false, message: '连接超时' });
                    }
                }, 8000);

                let initialConnect = true;
                client.on('connect', () => {
                    if (ctx.closing || this.conns.get(p.connectionId) !== ctx) return;
                    this.sendState(p.connectionId, 'connected');
                    if (initialConnect) {
                        initialConnect = false;
                        clearTimeout(hardTimeout);
                        console.log(`[mqtt][${p.connectionId}] CONNECT OK ${url}`);
                        writeDiagnosticLog('[mqtt] connect ok', {
                            connectionId: p.connectionId,
                            url,
                            activeConnections: this.conns.size
                        });
                        settle({ success: true });
                    } else {
                        console.log(`[mqtt][${p.connectionId}] RECONNECTED ${url}`);
                        writeDiagnosticLog('[mqtt] reconnected', {
                            connectionId: p.connectionId,
                            url,
                            activeConnections: this.conns.size
                        });
                    }
                });
                client.on('reconnect', () => {
                    if (!ctx.closing && this.conns.get(p.connectionId) === ctx) this.sendState(p.connectionId, 'reconnecting');
                });
                client.on('offline', () => {
                    if (!ctx.closing && this.conns.get(p.connectionId) === ctx) this.sendState(p.connectionId, 'offline');
                });
                client.on('close', () => {
                    if (ctx.closing) {
                        clearTimeout(hardTimeout);
                        if (initialConnect && !settled) settle({ success: false, message: '连接已取消' });
                        writeDiagnosticLog('[mqtt] closed', { connectionId: p.connectionId, activeConnections: this.conns.size });
                        if (this.conns.get(p.connectionId) === ctx) {
                            this.conns.delete(p.connectionId);
                            this.sendState(p.connectionId, 'closed');
                        }
                        return;
                    }
                    if (this.conns.get(p.connectionId) !== ctx) return;
                    if (initialConnect && !settled) {
                        // 首次还没连上就关闭（broker 拒绝 / 网络直接断）
                        clearTimeout(hardTimeout);
                        try { client.end(true); } catch {}
                        this.conns.delete(p.connectionId);
                        this.ipcQueue.dropConnection(p.connectionId);
                        settle({ success: false, message: '连接被关闭' });
                        return;
                    }
                    this.sendState(p.connectionId, 'reconnecting');
                });
                client.on('error', (err) => {
                    if (ctx.closing || this.conns.get(p.connectionId) !== ctx) return;
                    this.sendState(p.connectionId, 'error', err.message);
                    if (initialConnect && !settled) {
                        clearTimeout(hardTimeout);
                        try { client.end(true); } catch {}
                        this.conns.delete(p.connectionId);
                        this.ipcQueue.dropConnection(p.connectionId);
                        settle({ success: false, message: err.message });
                    }
                });

                client.on('message', (topic, payload, _packet?: IPublishPacket) => {
                    this.enqueueIncomingMessage(ctx, p.connectionId, topic, payload);
                });
            } catch (e) {
                settle({ success: false, message: (e as Error).message });
            }
        });
    }

    disconnect(connectionId: string): ApiResult {
        const ctx = this.conns.get(connectionId);
        if (ctx) {
            writeDiagnosticLog('[mqtt] disconnect request', {
                connectionId,
                connected: ctx.client.connected,
                queuedMessages: this.queuedMessageCount(),
                activeConnections: this.conns.size
            });
            ctx.closing = true;
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
            let settled = false;
            const finish = (result: ApiResult) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(result);
            };
            const timer = setTimeout(() => {
                writeDiagnosticLog('[mqtt] subscribe timeout', { connectionId, topic: normalized, timeoutMs: MQTT_OPERATION_TIMEOUT_MS });
                finish({ success: false, message: '订阅超时' });
            }, MQTT_OPERATION_TIMEOUT_MS);
            ctx.client.subscribe(normalized, { qos }, (err, granted) => {
                if (err) {
                    console.log(`[mqtt][${connectionId}] sub FAIL:`, normalized, err.message);
                    finish({ success: false, message: err.message });
                } else {
                    console.log(`[mqtt][${connectionId}] sub OK:`, granted?.map((g) => `${g.topic}@qos${g.qos}`).join(','));
                    finish({ success: true });
                }
            });
        });
    }

    unsubscribe(connectionId: string, topic: string): Promise<ApiResult> {
        const ctx = this.conns.get(connectionId);
        if (!ctx || !ctx.client.connected) return Promise.resolve({ success: false, message: '未连接' });
        const normalized = topic.trim().replace(/＋/g, '+');
        return new Promise((resolve) => {
            let settled = false;
            const finish = (result: ApiResult) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(result);
            };
            const timer = setTimeout(() => {
                writeDiagnosticLog('[mqtt] unsubscribe timeout', { connectionId, topic: normalized, timeoutMs: MQTT_OPERATION_TIMEOUT_MS });
                finish({ success: false, message: '取消订阅超时' });
            }, MQTT_OPERATION_TIMEOUT_MS);
            ctx.client.unsubscribe(normalized, (err) => {
                if (err) finish({ success: false, message: err.message });
                else finish({ success: true });
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

    private enqueueIncomingMessage(ctx: ConnectionCtx, connectionId: string, topic: string, payload: Buffer): void {
        if (this.shuttingDown || ctx.closing || ctx.disabledTopics.has(topic)) return;
        if (this.storageBackpressured) {
            ctx.droppedMessages++;
            if (ctx.droppedMessages === 1 || ctx.droppedMessages % 5000 === 0) {
                writeDiagnosticLog('[storage] mqtt message skipped during backpressure', {
                    connectionId,
                    droppedMessages: ctx.droppedMessages,
                    topic
                });
            }
            return;
        }
        if (this.queuedMessageCount() >= MESSAGE_PROCESS_QUEUE_HARD) {
            const dropped = this.dropQueuedMessages(Math.ceil(MESSAGE_PROCESS_QUEUE_HARD * 0.1));
            ctx.droppedMessages += dropped;
            const snapshot = this.diagnosticsSnapshot();
            console.warn(`[mqtt][${connectionId}] 入站消息积压超限，已丢弃 ${dropped} 条，避免主进程卡死`);
            writeDiagnosticLog('[mqtt] message queue overflow', { connectionId, dropped, ...snapshot });
        }
        this.messageQueue.push({ ctx, connectionId, topic, payload: Buffer.from(payload) });
        this.scheduleMessageProcessing();
    }

    private queuedMessageCount(): number {
        return this.messageQueue.length - this.messageQueueHead;
    }

    private dropQueuedMessages(count: number): number {
        const dropped = Math.min(count, this.queuedMessageCount());
        this.messageQueueHead += dropped;
        this.compactMessageQueueIfNeeded();
        return dropped;
    }

    private compactMessageQueueIfNeeded(): void {
        if (this.messageQueueHead === 0) return;
        if (this.messageQueueHead >= this.messageQueue.length) {
            this.messageQueue.length = 0;
            this.messageQueueHead = 0;
            return;
        }
        if (this.messageQueueHead >= 4096 && this.messageQueueHead * 2 >= this.messageQueue.length) {
            this.messageQueue = this.messageQueue.slice(this.messageQueueHead);
            this.messageQueueHead = 0;
        }
    }

    private scheduleMessageProcessing(): void {
        if (this.messageQueueTimer || this.shuttingDown) return;
        this.messageQueueTimer = setTimeout(() => {
            this.messageQueueTimer = null;
            this.processMessageQueue();
        }, MESSAGE_PROCESS_INTERVAL_MS);
    }

    private processMessageQueue(): void {
        if (isStorageBackpressured()) return;
        const batchSize = Math.min(MESSAGE_PROCESS_BATCH, this.queuedMessageCount());
        for (let i = 0; i < batchSize; i++) {
            if (isStorageBackpressured()) break;
            const item = this.messageQueue[this.messageQueueHead++];
            if (!item) break;
            const { ctx, connectionId, topic, payload } = item;
            if (this.shuttingDown || ctx.closing || ctx.disabledTopics.has(topic)) continue;
            const payloadView = decodePayloadView(payload);
            const text = payloadView.text;
            const now = Date.now();

            enqueueMessage(connectionId, topic, text, now, {
                payloadSize: payloadView.size,
                payloadEncoding: payloadView.encoding
            });
            const msg: MqttMessage = {
                connectionId,
                topic,
                payload: text,
                payloadSize: payloadView.size,
                payloadEncoding: payloadView.encoding,
                time: now,
                seq: ++this.seq
            };
            this.ipcQueue.enqueue(msg);
            ctx.msgCount++;
            if (ctx.msgCount <= 3 || ctx.msgCount % 5000 === 0) {
                const dropped = ctx.droppedMessages ? `, dropped=${ctx.droppedMessages}` : '';
                console.log(`[mqtt][${connectionId}] msg #${ctx.msgCount} ${topic} (${text.length}B${dropped})`);
            }
        }
        this.compactMessageQueueIfNeeded();
        if (this.queuedMessageCount() > 0 && !isStorageBackpressured()) this.scheduleMessageProcessing();
    }

    private setStorageBackpressure(pressured: boolean): void {
        if (this.storageBackpressured === pressured) return;
        this.storageBackpressured = pressured;
        writeDiagnosticLog(pressured ? '[storage] backpressure on' : '[storage] backpressure off', this.diagnosticsSnapshot());
        if (!pressured && this.queuedMessageCount() > 0) this.scheduleMessageProcessing();
    }

    private diagnosticsSnapshot(): Record<string, unknown> {
        const mem = process.memoryUsage();
        return {
            activeConnections: this.conns.size,
            messageQueue: this.queuedMessageCount(),
            ipcQueue: this.ipcQueue.size(),
            rssMb: Math.round(mem.rss / 1024 / 1024),
            heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
            externalMb: Math.round(mem.external / 1024 / 1024),
            storageBackpressured: this.storageBackpressured,
            connections: [...this.conns.values()].map((ctx) => ({
                id: ctx.id,
                connected: ctx.client.connected,
                msgCount: ctx.msgCount,
                droppedMessages: ctx.droppedMessages,
                disabledTopics: ctx.disabledTopics.size
            }))
        };
    }

    private startDiagnostics(): void {
        if (this.diagnosticsTimer) return;
        this.diagnosticsTimer = setInterval(() => {
            const snapshot = this.diagnosticsSnapshot();
            if (snapshot.activeConnections || snapshot.messageQueue || snapshot.ipcQueue) {
                writeDiagnosticLog('[mqtt] runtime snapshot', snapshot);
                if (!this.storageDiagnosticsInFlight) {
                    this.storageDiagnosticsInFlight = true;
                    void getStorageDiagnosticsAsync().then((storage) => {
                        writeDiagnosticLog('[storage] runtime snapshot', storage);
                    }).finally(() => {
                        this.storageDiagnosticsInFlight = false;
                    });
                }
            }
        }, 60_000);
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
        setStoragePressureListener(null);
        writeDiagnosticLog('[mqtt] shutdown', this.diagnosticsSnapshot());
        if (this.diagnosticsTimer) {
            clearInterval(this.diagnosticsTimer);
            this.diagnosticsTimer = null;
        }
        if (this.messageQueueTimer) {
            clearTimeout(this.messageQueueTimer);
            this.messageQueueTimer = null;
        }
        this.messageQueue.length = 0;
        this.messageQueueHead = 0;
        this.ipcQueue.flush();
        for (const id of [...this.conns.keys()]) this.disconnect(id);
        this.ipcQueue.shutdown();
    }
}
