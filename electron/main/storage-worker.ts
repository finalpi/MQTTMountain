import { parentPort, workerData } from 'node:worker_threads';
import { initStorage, enqueueMessage, flushStorage, closeAllLogDbs, pauseStorageWrites, resumeStorageWrites, shutdownStorage } from './storage';
import type { BucketItem } from './history-bucket-codec';

interface StorageWorkerRequest {
    id?: number;
    command: string;
    payload?: unknown;
}

interface EnqueuePayload extends Partial<BucketItem> {
    connectionId: string;
    topic: string;
    payload: string;
    tsMs: number;
}

initStorage((workerData as { logRoot: string }).logRoot);

function reply(id: number | undefined, ok: boolean, result?: unknown, error?: unknown): void {
    if (id == null) return;
    parentPort?.postMessage({
        id,
        ok,
        result,
        error: error instanceof Error ? error.message : error ? String(error) : undefined
    });
}

parentPort?.on('message', (msg: StorageWorkerRequest) => {
    try {
        switch (msg.command) {
            case 'enqueue': {
                const item = msg.payload as EnqueuePayload;
                enqueueMessage(item.connectionId, item.topic, item.payload, item.tsMs, item);
                reply(msg.id, true);
                break;
            }
            case 'flush':
                flushStorage();
                reply(msg.id, true);
                break;
            case 'pause':
                pauseStorageWrites('worker-rpc');
                reply(msg.id, true);
                break;
            case 'resume':
                resumeStorageWrites('worker-rpc');
                reply(msg.id, true);
                break;
            case 'closeAll':
                closeAllLogDbs();
                reply(msg.id, true);
                break;
            case 'shutdown':
                shutdownStorage();
                reply(msg.id, true);
                break;
            default:
                throw new Error(`unknown storage worker command: ${msg.command}`);
        }
    } catch (error) {
        reply(msg.id, false, undefined, error);
    }
});
