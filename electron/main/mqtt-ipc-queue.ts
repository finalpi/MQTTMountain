import type { BrowserWindow } from 'electron';
import type { MqttMessage } from '../../shared/types';

interface QueuePriority {
    connectionId: string;
    topic: string | null;
}

const IPC_FLUSH_MS = 33;
const IPC_BATCH_HARD = 800;
const IPC_QUEUE_HARD = 16000;
const IPC_BACKLOG_FLUSH_MS = 0;

export class MqttIpcQueue {
    private queue: MqttMessage[] = [];
    private timer: NodeJS.Timeout | null = null;
    private activeConnectionId: string | null = null;
    private pausedConnections = new Set<string>();
    private priorityTopics = new Map<string, string | null>();

    constructor(private readonly getWin: () => BrowserWindow | null) {}

    enqueue(msg: MqttMessage): void {
        if (!this.shouldSend(msg.connectionId)) return;
        this.queue.push(msg);
        if (this.queue.length > IPC_QUEUE_HARD) {
            this.trimQueue(this.priorityFor(msg.connectionId));
        }
        if (this.queue.length >= IPC_BATCH_HARD) this.flush();
        else this.scheduleFlush(IPC_FLUSH_MS);
    }

    setActiveConnection(connectionId: string | null): void {
        this.activeConnectionId = connectionId || null;
        this.trimInactiveQueuedMessages();
    }

    setDisplayPaused(connectionId: string, paused: boolean): void {
        if (!connectionId) return;
        if (paused) this.pausedConnections.add(connectionId);
        else this.pausedConnections.delete(connectionId);
        this.trimInactiveQueuedMessages();
    }

    setPriorityTopic(connectionId: string, topic: string | null): void {
        if (!connectionId) return;
        this.priorityTopics.set(connectionId, topic);
    }

    dropConnection(connectionId: string): void {
        if (!connectionId) return;
        this.pausedConnections.delete(connectionId);
        this.priorityTopics.delete(connectionId);
        this.queue = this.queue.filter((item) => item.connectionId !== connectionId);
    }

    flush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.queue.length === 0) return;
        this.trimInactiveQueuedMessages();
        if (this.queue.length === 0) return;

        const win = this.getWin();
        if (!win || win.isDestroyed()) {
            this.queue.length = 0;
            return;
        }

        const batch = this.queue.splice(0, Math.min(this.queue.length, IPC_BATCH_HARD));
        try {
            win.webContents.send('mqtt:messages', batch);
        } catch (e) {
            console.error('[mqtt] send batch:', e);
        }

        if (this.queue.length > 0) this.scheduleFlush(IPC_BACKLOG_FLUSH_MS);
    }

    shutdown(): void {
        this.flush();
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.queue.length = 0;
        this.pausedConnections.clear();
        this.priorityTopics.clear();
        this.activeConnectionId = null;
    }

    private shouldSend(connectionId: string): boolean {
        return !!this.activeConnectionId
            && connectionId === this.activeConnectionId
            && !this.pausedConnections.has(connectionId);
    }

    private priorityFor(connectionId: string): QueuePriority | null {
        if (!connectionId) return null;
        if (!this.priorityTopics.has(connectionId)) return null;
        return { connectionId, topic: this.priorityTopics.get(connectionId) ?? null };
    }

    private trimInactiveQueuedMessages(): void {
        this.queue = this.activeConnectionId
            ? this.queue.filter((item) => this.shouldSend(item.connectionId))
            : [];
    }

    private trimQueue(priority: QueuePriority | null): void {
        const excess = this.queue.length - IPC_QUEUE_HARD;
        if (excess <= 0) return;
        const mark = new Uint8Array(this.queue.length);
        let removed = 0;
        if (priority) {
            for (let i = 0; i < this.queue.length && removed < excess; i++) {
                const item = this.queue[i];
                const matchesPriority = item.connectionId === priority.connectionId
                    && (priority.topic == null || item.topic === priority.topic);
                if (!matchesPriority) {
                    mark[i] = 1;
                    removed++;
                }
            }
        }
        if (removed < excess) {
            for (let i = 0; i < this.queue.length && removed < excess; i++) {
                if (!mark[i]) {
                    mark[i] = 1;
                    removed++;
                }
            }
        }
        const kept = new Array<MqttMessage>(this.queue.length - removed);
        let k = 0;
        for (let i = 0; i < this.queue.length; i++) if (!mark[i]) kept[k++] = this.queue[i];
        this.queue = kept;
        const priorityLabel = priority ? `${priority.connectionId}:${priority.topic}` : 'none';
        console.warn(`[mqtt] IPC 队列积压超限，已降采样丢弃 ${removed} 条（priority=${priorityLabel}）`);
    }

    private scheduleFlush(delayMs: number): void {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
        }, delayMs);
    }
}
