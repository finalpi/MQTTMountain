import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WebContents } from 'electron';
import type { HistoryMessage, HistoryQueryOptions, HistoryQueryStreamStartRequest } from '../../shared/types';
import { flushStorage, getLogRoot } from './storage';

interface WorkerMessage {
    type: 'chunk' | 'done' | 'error';
    requestId?: string;
    rows?: HistoryMessage[];
    data?: HistoryMessage[];
    total?: number;
    truncated?: boolean;
    error?: string;
}

const activeStreams = new Map<string, { worker: Worker; sender: WebContents }>();

function stopStream(requestId: string): void {
    const active = activeStreams.get(requestId);
    if (!active) return;
    activeStreams.delete(requestId);
    void active.worker.terminate().catch(() => {});
}

function sendIfAlive(sender: WebContents, channel: string, payload: unknown): boolean {
    if (sender.isDestroyed()) return false;
    sender.send(channel, payload);
    return true;
}

export async function queryHistoryAsync(opts: HistoryQueryOptions): Promise<HistoryMessage[]> {
    flushStorage();

    const workerPath = path.join(__dirname, 'history-query-worker.js');
    const worker = new Worker(workerPath, {
        workerData: {
            opts,
            logRoot: getLogRoot()
        }
    });

    return await new Promise<HistoryMessage[]>((resolve, reject) => {
        let settled = false;

        worker.on('message', (msg: WorkerMessage) => {
            if (msg.type === 'done' && msg.data) {
                settled = true;
                resolve(msg.data);
                return;
            }
            if (msg.type === 'error') {
                settled = true;
                reject(new Error(msg.error || '查询失败'));
            }
        });

        worker.once('error', (error) => {
            settled = true;
            reject(error);
        });

        worker.once('exit', (code) => {
            if (!settled && code !== 0) {
                reject(new Error(`查询任务异常退出（${code}）`));
            }
        });
    }).finally(() => {
        void worker.terminate().catch(() => {});
    });
}

export function startHistoryQueryStream(sender: WebContents, req: HistoryQueryStreamStartRequest): void {
    flushStorage();
    stopStream(req.requestId);

    const workerPath = path.join(__dirname, 'history-query-worker.js');
    const worker = new Worker(workerPath, {
        workerData: {
            opts: req.opts || {},
            logRoot: getLogRoot(),
            stream: true,
            requestId: req.requestId,
            chunkSize: req.chunkSize
        }
    });
    activeStreams.set(req.requestId, { worker, sender });

    const cleanup = (): void => {
        const active = activeStreams.get(req.requestId);
        if (active?.worker === worker) activeStreams.delete(req.requestId);
    };
    const sendError = (message: string): void => {
        const active = activeStreams.get(req.requestId);
        if (!active || active.worker !== worker) return;
        sendIfAlive(active.sender, 'history:queryError', { requestId: req.requestId, message });
        cleanup();
    };

    worker.on('message', (msg: WorkerMessage) => {
        const active = activeStreams.get(req.requestId);
        if (!active || active.worker !== worker) return;
        if (active.sender.isDestroyed()) {
            stopStream(req.requestId);
            return;
        }
        if (msg.type === 'chunk') {
            sendIfAlive(active.sender, 'history:queryChunk', { requestId: req.requestId, rows: msg.rows ?? [] });
            return;
        }
        if (msg.type === 'done') {
            sendIfAlive(active.sender, 'history:queryDone', { requestId: req.requestId, total: msg.total ?? 0, truncated: Boolean(msg.truncated) });
            cleanup();
            return;
        }
        if (msg.type === 'error') {
            sendError(msg.error || '查询失败');
        }
    });

    worker.once('error', (error) => sendError(error.message || '查询失败'));
    worker.once('exit', (code) => {
        const active = activeStreams.get(req.requestId);
        if (!active || active.worker !== worker) return;
        if (code !== 0) sendError(`查询任务异常退出（${code}）`);
        else cleanup();
    });
}

export function cancelHistoryQueryStream(requestId: string): void {
    stopStream(requestId);
}
