import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WebContents } from 'electron';
import type { HistoryIndexProgress, HistoryIndexRequest, HistoryIndexResult } from '../../shared/types';
import { scheduleHeavyJob } from './heavy-job-scheduler';
import { flushStorage, getHistoryIndexStatus, getLogRoot } from './storage';

interface WorkerMessage {
    type: 'progress' | 'done' | 'error';
    progress?: HistoryIndexProgress;
    result?: HistoryIndexResult;
    error?: string;
}

function sendProgress(sender: WebContents, progress: HistoryIndexProgress): void {
    if (!sender.isDestroyed()) sender.send('history:indexProgress', progress);
}

export function readHistoryIndexStatus(req: HistoryIndexRequest = {}) {
    return getHistoryIndexStatus(req.connectionId ?? null);
}

export async function buildHistoryIndex(sender: WebContents, req: HistoryIndexRequest = {}): Promise<HistoryIndexResult> {
    return await scheduleHeavyJob({ kind: 'exclusive', label: 'history-index', priority: 10 }, async () => {
        flushStorage();

        const workerPath = path.join(__dirname, 'history-index-worker.js');
        const worker = new Worker(workerPath, {
            workerData: {
                req,
                logRoot: getLogRoot()
            }
        });

        return await new Promise<HistoryIndexResult>((resolve, reject) => {
            let settled = false;

            worker.on('message', (msg: WorkerMessage) => {
                if (msg.type === 'progress' && msg.progress) {
                    sendProgress(sender, msg.progress);
                    return;
                }
                if (msg.type === 'done' && msg.result) {
                    settled = true;
                    sendProgress(sender, {
                        stage: 'done',
                        connectionId: req.connectionId ?? undefined,
                        processedFiles: msg.result.processedFiles,
                        totalFiles: msg.result.totalFiles,
                        processedBuckets: msg.result.processedBuckets,
                        processedMessages: msg.result.processedMessages,
                        percent: 100,
                        fts5Enabled: msg.result.fts5Enabled,
                        message: `索引完成：${msg.result.processedMessages.toLocaleString()} 条消息`
                    });
                    resolve(msg.result);
                    return;
                }
                if (msg.type === 'error') {
                    settled = true;
                    reject(new Error(msg.error || '索引建立失败'));
                }
            });

            worker.once('error', (error) => {
                settled = true;
                reject(error);
            });

            worker.once('exit', (code) => {
                if (!settled && code !== 0) {
                    reject(new Error(`索引任务异常退出（${code}）`));
                }
            });
        }).finally(() => {
            void worker.terminate().catch(() => {});
        });
    }).promise;
}
