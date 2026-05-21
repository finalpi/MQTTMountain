import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { HistoryMessage, HistoryQueryOptions } from '../../shared/types';
import { flushStorage, getLogRoot } from './storage';

interface WorkerMessage {
    type: 'done' | 'error';
    data?: HistoryMessage[];
    error?: string;
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
