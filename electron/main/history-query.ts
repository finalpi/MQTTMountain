import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WebContents } from 'electron';
import type { HistoryMessage, HistoryQueryOptions, HistoryQueryStreamStartRequest } from '../../shared/types';
import { scheduleHeavyJob, type ScheduledHeavyJob } from './heavy-job-scheduler';
import { flushStorageAsync, getLogRoot } from './storage';

interface WorkerMessage {
    type: 'chunk' | 'done' | 'error';
    requestId?: string;
    rows?: HistoryMessage[];
    data?: HistoryMessage[];
    total?: number;
    truncated?: boolean;
    error?: string;
}

interface ActiveStream {
    sender: WebContents;
    worker: Worker | null;
    job: ScheduledHeavyJob<void> | null;
    cancelled: boolean;
}

const activeStreams = new Map<string, ActiveStream>();
const QUERY_FLUSH_WAIT_MS = 80;
const QUERY_RECENT_WINDOW_MS = 5_000;

function shouldFlushForQuery(opts: HistoryQueryOptions): boolean {
    if (opts.freshness === 'strict') return true;
    if (opts.freshness === 'stale-ok') return false;
    const endTime = opts.endTime;
    return endTime == null || endTime <= 0 || endTime >= Date.now() - QUERY_RECENT_WINDOW_MS;
}

async function flushStorageForQuery(opts: HistoryQueryOptions): Promise<void> {
    if (!shouldFlushForQuery(opts)) return;
    let timeoutId: NodeJS.Timeout | null = null;
    try {
        await Promise.race([
            flushStorageAsync(),
            new Promise<void>((resolve) => {
                timeoutId = setTimeout(resolve, QUERY_FLUSH_WAIT_MS);
            })
        ]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

function stopStream(requestId: string): void {
    const active = activeStreams.get(requestId);
    if (!active) return;
    active.cancelled = true;
    activeStreams.delete(requestId);
    active.job?.cancel();
    void active.worker?.terminate().catch(() => {});
}

function sendIfAlive(sender: WebContents, channel: string, payload: unknown): boolean {
    if (sender.isDestroyed()) return false;
    sender.send(channel, payload);
    return true;
}

export async function queryHistoryAsync(opts: HistoryQueryOptions): Promise<HistoryMessage[]> {
    return await scheduleHeavyJob({ kind: 'query', label: 'history-query', priority: 20 }, async () => {
        await flushStorageForQuery(opts);

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
    }).promise;
}

async function runHistoryQueryStream(sender: WebContents, req: HistoryQueryStreamStartRequest): Promise<void> {
    const active = activeStreams.get(req.requestId);
    if (!active || active.cancelled) return;

    const opts = req.opts || {};
    await flushStorageForQuery(opts);

    return await new Promise<void>((resolve, reject) => {
        const workerPath = path.join(__dirname, 'history-query-worker.js');
        const worker = new Worker(workerPath, {
            workerData: {
                opts,
                logRoot: getLogRoot(),
                stream: true,
                requestId: req.requestId,
                chunkSize: req.chunkSize
            }
        });
        active.worker = worker;

        const cleanup = (): void => {
            const current = activeStreams.get(req.requestId);
            if (current?.worker === worker) activeStreams.delete(req.requestId);
        };
        const sendError = (message: string): void => {
            const current = activeStreams.get(req.requestId);
            if (!current || current.worker !== worker || current.cancelled) return;
            sendIfAlive(current.sender, 'history:queryError', { requestId: req.requestId, message });
            cleanup();
        };

        worker.on('message', (msg: WorkerMessage) => {
            const current = activeStreams.get(req.requestId);
            if (!current || current.worker !== worker || current.cancelled) return;
            if (current.sender.isDestroyed()) {
                stopStream(req.requestId);
                resolve();
                return;
            }
            if (msg.type === 'chunk') {
                sendIfAlive(current.sender, 'history:queryChunk', { requestId: req.requestId, rows: msg.rows ?? [] });
                return;
            }
            if (msg.type === 'done') {
                sendIfAlive(current.sender, 'history:queryDone', { requestId: req.requestId, total: msg.total ?? 0, truncated: Boolean(msg.truncated) });
                cleanup();
                resolve();
                return;
            }
            if (msg.type === 'error') {
                sendError(msg.error || '查询失败');
                reject(new Error(msg.error || '查询失败'));
            }
        });

        worker.once('error', (error) => {
            sendError(error.message || '查询失败');
            reject(error);
        });
        worker.once('exit', (code) => {
            const current = activeStreams.get(req.requestId);
            if (!current || current.worker !== worker) {
                resolve();
                return;
            }
            if (current.cancelled) {
                cleanup();
                resolve();
                return;
            }
            if (code !== 0) {
                const error = new Error(`查询任务异常退出（${code}）`);
                sendError(error.message);
                reject(error);
            } else {
                cleanup();
                resolve();
            }
        });
    });
}

export function startHistoryQueryStream(sender: WebContents, req: HistoryQueryStreamStartRequest): void {
    stopStream(req.requestId);

    const active: ActiveStream = { sender, worker: null, job: null, cancelled: false };
    activeStreams.set(req.requestId, active);
    const job = scheduleHeavyJob({ kind: 'query', label: 'history-query-stream', priority: 30 }, () => runHistoryQueryStream(sender, req));
    active.job = job;
    void job.promise.catch((error) => {
        const current = activeStreams.get(req.requestId);
        if (!current || current !== active || current.cancelled) return;
        sendIfAlive(current.sender, 'history:queryError', { requestId: req.requestId, message: (error as Error).message || '查询失败' });
        activeStreams.delete(req.requestId);
    });
}

export function cancelHistoryQueryStream(requestId: string): void {
    stopStream(requestId);
}
