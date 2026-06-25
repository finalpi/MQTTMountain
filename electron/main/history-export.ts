import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WebContents } from 'electron';
import type {
    HistoryExportProgress,
    HistoryExportRequest,
    HistoryExportResult
} from '../../shared/types';
import { scheduleHeavyJob } from './heavy-job-scheduler';
import { flushStorageAsync, getLogRoot } from './storage';

interface WorkerMessage {
    type: 'progress' | 'done' | 'error';
    progress?: HistoryExportProgress;
    result?: HistoryExportResult;
    error?: string;
}

function sendProgress(sender: WebContents, progress: HistoryExportProgress): void {
    if (!sender.isDestroyed()) sender.send('history:exportProgress', progress);
}

export async function exportHistoryToFile(sender: WebContents, req: HistoryExportRequest, targetPath: string): Promise<HistoryExportResult> {
    return await scheduleHeavyJob({ kind: 'exclusive', label: 'history-export', priority: 5 }, async () => {
        await flushStorageAsync();

        const workerPath = path.join(__dirname, 'history-export-worker.js');
        const worker = new Worker(workerPath, {
            workerData: {
                req,
                targetPath,
                logRoot: getLogRoot()
            }
        });

        return await new Promise<HistoryExportResult>((resolve, reject) => {
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
                        processed: msg.result.totalRows,
                        written: msg.result.totalRows,
                        total: msg.result.totalRows,
                        percent: 100,
                        filePath: msg.result.filePath,
                        dirPath: msg.result.dirPath,
                        format: msg.result.format,
                        message: '导出完成'
                    });
                    resolve(msg.result);
                    return;
                }
                if (msg.type === 'error') {
                    settled = true;
                    reject(new Error(msg.error || '导出失败'));
                }
            });

            worker.once('error', (error) => {
                settled = true;
                reject(error);
            });

            worker.once('exit', (code) => {
                if (!settled && code !== 0) {
                    reject(new Error(`导出任务异常退出（${code}）`));
                }
            });
        }).finally(() => {
            void worker.terminate().catch(() => {});
        });
    }).promise;
}
