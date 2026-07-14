import { parentPort, workerData } from 'node:worker_threads';
import { initStorage, enqueueMessage, flushStorage, closeAllLogDbs, pauseStorageWrites, resumeStorageWrites, shutdownStorage, stopAcceptingStorageWrites, getStorageDiagnostics, setStorageDiagnosticListener, flushDeferredHistoryFts } from './storage';
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

setStorageDiagnosticListener((label, ...values) => {
    parentPort?.postMessage({ type: 'diagnostic', label, values });
});
initStorage((workerData as { logRoot: string }).logRoot);

let processedBatches = 0;
let processedEntries = 0;
let lastBatchMs = 0;
let maxBatchMs = 0;
let maxEventLoopLagMs = 0;
let durableAckTimer: NodeJS.Timeout | null = null;
const pendingDurableAcks: Array<{ id: number; entries: number; receivedAt: number }> = [];
const DURABLE_ACK_RETRY_MS = 1000;
let expectedTickAt = Date.now() + 1000;
const lagTimer = setInterval(() => {
    const now = Date.now();
    maxEventLoopLagMs = Math.max(maxEventLoopLagMs, Math.max(0, now - expectedTickAt));
    expectedTickAt = now + 1000;
}, 1000);
lagTimer.unref();

function workerDiagnostics(): Record<string, unknown> {
    return {
        ...getStorageDiagnostics(),
        processedBatches,
        processedEntries,
        lastBatchMs,
        maxBatchMs,
        maxEventLoopLagMs,
        pendingDurableBatches: pendingDurableAcks.length,
        pendingDurableEntries: pendingDurableAcks.reduce((sum, item) => sum + item.entries, 0),
        oldestDurableAckAgeMs: pendingDurableAcks.length ? Date.now() - pendingDurableAcks[0].receivedAt : 0
    };
}

function reply(id: number | undefined, ok: boolean, result?: unknown, error?: unknown): void {
    if (id == null) return;
    parentPort?.postMessage({
        id,
        ok,
        result,
        error: error instanceof Error ? error.message : error ? String(error) : undefined
    });
}

function pendingEntryCount(): number {
    const value = getStorageDiagnostics().pendingEntries;
    return typeof value === 'number' ? value : Number(value ?? 0);
}

function acknowledgeCommittedBatches(): boolean {
    if (pendingEntryCount() > 0) return false;
    const committed = pendingDurableAcks.splice(0, pendingDurableAcks.length);
    for (const ack of committed) {
        reply(ack.id, true, { durable: true, entries: ack.entries });
    }
    return true;
}

function flushAndAcknowledge(): boolean {
    flushStorage();
    return acknowledgeCommittedBatches();
}

function scheduleDurableAck(): void {
    if (durableAckTimer || pendingDurableAcks.length === 0) return;
    durableAckTimer = setTimeout(() => {
        durableAckTimer = null;
        if (!flushAndAcknowledge()) scheduleDurableAck();
    }, DURABLE_ACK_RETRY_MS);
}

parentPort?.on('message', (msg: StorageWorkerRequest) => {
    try {
        switch (msg.command) {
            case 'enqueue': {
                const item = msg.payload as EnqueuePayload;
                enqueueMessage(item.connectionId, item.topic, item.payload, item.tsMs, item);
                if (msg.id != null) pendingDurableAcks.push({ id: msg.id, entries: 1, receivedAt: Date.now() });
                scheduleDurableAck();
                break;
            }
            case 'enqueueBatch': {
                if (!Array.isArray(msg.payload)) throw new Error('enqueueBatch payload must be an array');
                const batch = msg.payload as EnqueuePayload[];
                const startedAt = Date.now();
                for (const item of batch) {
                    enqueueMessage(item.connectionId, item.topic, item.payload, item.tsMs, item);
                }
                lastBatchMs = Date.now() - startedAt;
                maxBatchMs = Math.max(maxBatchMs, lastBatchMs);
                processedBatches++;
                processedEntries += batch.length;
                if (msg.id != null) pendingDurableAcks.push({ id: msg.id, entries: batch.length, receivedAt: Date.now() });
                scheduleDurableAck();
                break;
            }
            case 'flush':
                if (!flushAndAcknowledge()) throw new Error('storage flush left pending entries');
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
                if (!acknowledgeCommittedBatches()) throw new Error('storage close left pending entries');
                reply(msg.id, true);
                break;
            case 'diagnostics':
                reply(msg.id, true, workerDiagnostics());
                break;
            case 'flushDeferredFts':
                reply(msg.id, true, flushDeferredHistoryFts(true, 'worker-rpc'));
                break;
            case 'shutdown':
                stopAcceptingStorageWrites();
                shutdownStorage();
                if (!acknowledgeCommittedBatches()) throw new Error('storage shutdown left pending entries');
                reply(msg.id, true);
                break;
            default:
                throw new Error(`unknown storage worker command: ${msg.command}`);
        }
    } catch (error) {
        reply(msg.id, false, undefined, error);
    }
});
