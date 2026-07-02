/**
 * 分片存储（B 方案 · 每秒合批）
 * 结构：
 *   <logRoot>/<sanitizedConnectionId>/<YYYY-MM-DD>.db
 *   table buckets:
 *     bucket_ts   INTEGER   -- 秒级时间戳 (second precision)
 *     topic       TEXT
 *     blob        BLOB      -- [u32 count][u16 offset_ms][u32 len][payload_utf8]...
 *     count       INTEGER   -- blob 内消息条数，与 header count 保持一致
 *     bytes       INTEGER   -- blob 字节数
 *     PRIMARY KEY(bucket_ts, topic)
 *
 * 写入策略：主进程把单条消息入内存合并器 pending，按 (ts_sec, topic) 聚合；
 *   每 STORAGE_FLUSH_MS 或 pending 总 payload 超过 STORAGE_FLUSH_BYTES 后写入对应 day.db。
 *   如果同一 (ts_sec, topic) 已存在，保留旧 blob，只追加新条目的编码尾部并修补 header count。
 */

import fs from 'node:fs';
import path from 'node:path';
import { Worker, isMainThread } from 'node:worker_threads';
import Database from 'better-sqlite3';
import type { HistoryIndexStatus, HistoryMessage, HistoryQueryOptions } from '../../shared/types';
import {
    appendEntriesToBucketBlob,
    decodeBucket,
    encodeBucket,
    iterateBucketEntries,
    validateBucketBlob,
    type BucketEntry,
    type BucketItem,
    type ExistingBucketRow
} from './history-bucket-codec';
import {
    DATE_KEY_FILE_RE,
    dateKeyFromTs,
    dayEndTsFromKey,
    dayStartTsFromKey,
    matchesText,
    normalizeConditions,
    normalizeSearchText,
    parseKeywordTerms,
    sanitizeConnectionId
} from './history-query-common';
import {
    ensureHistoryIndexSchema,
    getHistoryFtsTokenizer,
    getHistoryIndexSchemaVersion,
    getIndexMeta,
    HISTORY_INDEX_SCHEMA_VERSION,
    setIndexMeta
} from './history-index-schema';

const MAX_OPEN_LOG_DBS = 24;
const DAY_DB_FILE_RE = /^\d{4}-\d{2}-\d{2}\.db$/u;

let LOG_ROOT = '';

interface LogDbPack {
    db: Database.Database;
    getStmt: Database.Statement;
    upsertStmt: Database.Statement;
    insertIndexStmt: Database.Statement;
    insertFtsStmt: Database.Statement | null;
    deleteFtsStmt: Database.Statement | null;
    countIndexStmt: Database.Statement;
    insertBackupStmt: Database.Statement;
}

const logDbCache = new Map<string, LogDbPack>();
let storageWorker: Worker | null = null;
let storageWorkerSeq = 0;
let storageWorkerFailure: Error | null = null;
let storageWorkerFailureLogged = false;
let storageWorkerShuttingDown = false;
let storageAcceptingWrites = true;
const storageWorkerRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}>();
const autoDeleteWorkers = new Set<Worker>();

/** 单条消息条目（尚未合批） */
interface PendingEntry extends BucketItem {
    connectionId: string;
    topic: string;
}

const pending: PendingEntry[] = [];
let pendingBytes = 0;
let flushTimer: NodeJS.Timeout | null = null;
let maintenancePauseDepth = 0;
const storageWorkerBatch: PendingEntry[] = [];
let storageWorkerBatchBytes = 0;
let storageWorkerBatchTimer: NodeJS.Timeout | null = null;
const STORAGE_FLUSH_MS = 250;
const STORAGE_FLUSH_BYTES = 4 * 1024 * 1024;
const STORAGE_HARD_ENTRIES = 20_000;
const STORAGE_WORKER_BATCH_MS = 15;
const STORAGE_WORKER_BATCH_BYTES = 512 * 1024;
const STORAGE_WORKER_BATCH_ENTRIES = 1000;
const STORAGE_WORKER_RPC_TIMEOUT_MS = 30_000;
const STORAGE_WORKER_SHUTDOWN_TIMEOUT_MS = 8_000;
const USE_STORAGE_WORKER = isMainThread && process.env.MQTTMOUNTAIN_STORAGE_WORKER !== '0';

export function initStorage(logRoot: string): void {
    LOG_ROOT = logRoot;
    storageAcceptingWrites = true;
    fs.mkdirSync(LOG_ROOT, { recursive: true });
    if (USE_STORAGE_WORKER) ensureStorageWorker();
}

export function getLogRoot(): string {
    return LOG_ROOT;
}

function deleteDayDbFiles(filePath: string): number {
    let deleted = 0;
    for (const suffix of ['', '-wal', '-shm']) {
        const target = `${filePath}${suffix}`;
        if (!fs.existsSync(target)) continue;
        fs.rmSync(target, { force: true });
        deleted++;
    }
    return deleted;
}

function tableExists(db: Database.Database, name: string): boolean {
    const row = db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(name);
    return Boolean(row);
}

function isCurrentHistoryIndexDb(filePath: string): boolean {
    let db: Database.Database | null = null;
    try {
        db = new Database(filePath, { readonly: true });
        if (getIndexMeta(db, 'schema_version') !== HISTORY_INDEX_SCHEMA_VERSION) return false;
        const columns = new Set(db.prepare('PRAGMA table_info(history_messages)').all()
            .map((col) => String((col as { name?: string }).name ?? '')));
        const hasColumns = ['bucket_ts', 'topic', 'msg_index', 'time_ms', 'search_text', 'payload_offset', 'payload_len', 'entry_offset', 'entry_len']
            .every((name) => columns.has(name));
        if (!hasColumns) return false;
        return getHistoryFtsTokenizer(db) === 'none' || tableExists(db, 'history_messages_fts');
    } catch {
        return false;
    } finally {
        try { db?.close(); } catch {}
    }
}

function purgeNonCurrentHistoryIndexDbs(): number {
    if (!LOG_ROOT || !fs.existsSync(LOG_ROOT)) return 0;
    let deleted = 0;
    const dirs = fs.readdirSync(LOG_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const d of dirs) {
        const dir = path.join(LOG_ROOT, d.name);
        const files = fs.readdirSync(dir).filter((file) => DAY_DB_FILE_RE.test(file));
        for (const file of files) {
            const filePath = path.join(dir, file);
            if (isCurrentHistoryIndexDb(filePath)) continue;
            deleted += deleteDayDbFiles(filePath);
        }
    }
    if (deleted > 0) console.info(`[storage] purged ${deleted} old history db files; new history uses index schema v${HISTORY_INDEX_SCHEMA_VERSION}`);
    return deleted;
}

function rejectStorageWorkerRequests(error: Error): void {
    for (const request of storageWorkerRequests.values()) {
        clearTimeout(request.timer);
        request.reject(error);
    }
    storageWorkerRequests.clear();
}

function clearStorageWorkerBatchTimer(): void {
    if (!storageWorkerBatchTimer) return;
    clearTimeout(storageWorkerBatchTimer);
    storageWorkerBatchTimer = null;
}

function failStorageWorker(error: Error): void {
    if (!storageWorkerFailure) storageWorkerFailure = error;
    clearStorageWorkerBatchTimer();
    if (!storageWorkerFailureLogged) {
        storageWorkerFailureLogged = true;
        console.error('[storage] worker failed; history writes are disabled until app restart:', error);
    }
    rejectStorageWorkerRequests(error);
}

function ensureStorageWorker(): Worker | null {
    if (!USE_STORAGE_WORKER) return null;
    if (storageWorkerFailure) return null;
    if (storageWorker) return storageWorker;
    const workerPath = path.join(__dirname, 'storage-worker.js');
    storageWorker = new Worker(workerPath, { workerData: { logRoot: LOG_ROOT } });
    storageWorker.on('message', (msg: { id?: number; ok?: boolean; result?: unknown; error?: string }) => {
        if (msg.id == null) return;
        const request = storageWorkerRequests.get(msg.id);
        if (!request) return;
        storageWorkerRequests.delete(msg.id);
        clearTimeout(request.timer);
        if (msg.ok) request.resolve(msg.result);
        else request.reject(new Error(msg.error || 'storage worker error'));
    });
    storageWorker.once('error', (error) => {
        storageWorker = null;
        if (!storageWorkerShuttingDown) failStorageWorker(error);
        else rejectStorageWorkerRequests(error);
    });
    storageWorker.once('exit', (code) => {
        storageWorker = null;
        const error = new Error(`storage worker exited (${code})`);
        if (!storageWorkerShuttingDown) failStorageWorker(error);
        else rejectStorageWorkerRequests(error);
    });
    return storageWorker;
}

function storageWorkerUnavailableError(): Error {
    return storageWorkerFailure ?? new Error('storage worker is disabled');
}

function callStorageWorker(command: string, payload?: unknown, timeoutMs = STORAGE_WORKER_RPC_TIMEOUT_MS): Promise<unknown> {
    const worker = ensureStorageWorker();
    if (!worker) return Promise.reject(storageWorkerUnavailableError());
    const id = ++storageWorkerSeq;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            storageWorkerRequests.delete(id);
            reject(new Error(`storage worker ${command} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        storageWorkerRequests.set(id, { resolve, reject, timer });
        try {
            worker.postMessage({ id, command, payload });
        } catch (error) {
            storageWorkerRequests.delete(id);
            clearTimeout(timer);
            const err = error instanceof Error ? error : new Error(String(error));
            failStorageWorker(err);
            reject(err);
        }
    });
}

function postStorageWorker(command: string, payload?: unknown): boolean {
    const worker = ensureStorageWorker();
    if (!worker) return false;
    try {
        worker.postMessage({ command, payload });
        return true;
    } catch (error) {
        failStorageWorker(error instanceof Error ? error : new Error(String(error)));
        return false;
    }
}

function touchCacheKey(key: string): void {
    const v = logDbCache.get(key);
    if (v) {
        logDbCache.delete(key);
        logDbCache.set(key, v);
    }
}

function evictLogDbIfNeeded(): void {
    while (logDbCache.size >= MAX_OPEN_LOG_DBS) {
        const first = logDbCache.keys().next().value;
        if (first == null) break;
        const v = logDbCache.get(first);
        try { v?.db.close(); } catch {}
        logDbCache.delete(first);
    }
}

function getCompleteHistoryIndexVersion(db: Database.Database): string | null {
    const version = getHistoryIndexSchemaVersion(db);
    return version && getIndexMeta(db, 'index_complete') === '1' ? version : null;
}

function incrementIndexMeta(db: Database.Database, key: string, delta: number): void {
    if (delta <= 0) return;
    const updated = db.prepare(
        `UPDATE history_index_meta
         SET value = CAST(value AS INTEGER) + ?
         WHERE key = ?`
    ).run(delta, key);
    if (updated.changes === 0) setIndexMeta(db, key, delta);
}

function markIndexDirty(db: Database.Database): void {
    setIndexMeta(db, 'index_complete', '0');
    setIndexMeta(db, 'index_dirty_at', Date.now());
}

function refreshIndexedCounts(db: Database.Database): void {
    const messageRow = db.prepare('SELECT COUNT(*) AS count FROM history_messages').get() as { count: number };
    const bucketRow = db.prepare('SELECT COUNT(*) AS count FROM (SELECT 1 FROM history_messages GROUP BY bucket_ts, topic)').get() as { count: number };
    setIndexMeta(db, 'indexed_message_count', messageRow.count);
    setIndexMeta(db, 'indexed_bucket_count', bucketRow.count);
}

function appendBucketIndex(insertStmt: Database.Statement, insertFtsStmt: Database.Statement | null, bucketSec: number, topic: string, entries: BucketEntry[]): void {
    for (const entry of entries) {
        const searchText = normalizeSearchText(topic, entry.payload);
        insertStmt.run(bucketSec, topic, entry.msgIndex, entry.time, searchText, entry.payloadOffset, entry.payloadLen, entry.entryOffset, entry.entryLen);
        insertFtsStmt?.run(searchText, bucketSec, topic, entry.msgIndex, entry.time);
    }
}

function replaceBucketIndex(pack: LogDbPack, bucketSec: number, topic: string, entries: BucketEntry[]): void {
    const deleteStmt = pack.db.prepare('DELETE FROM history_messages WHERE bucket_ts = ? AND topic = ?');
    deleteStmt.run(bucketSec, topic);
    pack.deleteFtsStmt?.run(bucketSec, topic);
    appendBucketIndex(pack.insertIndexStmt, pack.insertFtsStmt, bucketSec, topic, entries);
}

function backupBucketBlob(pack: LogDbPack, bucketSec: number, topic: string, existing: ExistingBucketRow, reason?: string): boolean {
    let savedAt = Date.now();
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            pack.insertBackupStmt.run(bucketSec, topic, savedAt, reason || 'invalid bucket blob', existing.blob, existing.count, existing.bytes);
            return true;
        } catch (error) {
            savedAt++;
            if (attempt === 4) {
                console.error('[storage] backup suspicious bucket failed', bucketSec, topic, error);
                return false;
            }
        }
    }
    return false;
}

function getOrOpenLogDb(san: string, dk: string): LogDbPack {
    const key = `${san}|${dk}`;
    const cached = logDbCache.get(key);
    if (cached) {
        touchCacheKey(key);
        return cached;
    }
    evictLogDbIfNeeded();
    const dir = path.join(LOG_ROOT, san);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${dk}.db`);
    const db = new Database(filePath);
    db.exec(`
        CREATE TABLE IF NOT EXISTS buckets (
            bucket_ts INTEGER NOT NULL,
            topic     TEXT NOT NULL,
            blob      BLOB NOT NULL,
            count     INTEGER NOT NULL,
            bytes     INTEGER NOT NULL,
            PRIMARY KEY (bucket_ts, topic)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_buckets_ts ON buckets(bucket_ts);
        CREATE TABLE IF NOT EXISTS bucket_blob_backups (
            bucket_ts INTEGER NOT NULL,
            topic     TEXT NOT NULL,
            saved_at  INTEGER NOT NULL,
            reason    TEXT NOT NULL,
            blob      BLOB NOT NULL,
            count     INTEGER NOT NULL,
            bytes     INTEGER NOT NULL,
            PRIMARY KEY (bucket_ts, topic, saved_at)
        ) WITHOUT ROWID;
    `);
    const ftsTokenizer = ensureHistoryIndexSchema(db, { initializeCompletion: true });
    try {
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.pragma('temp_store = MEMORY');
        db.pragma('mmap_size = 268435456');
    } catch {}
    const getStmt = db.prepare('SELECT blob, count, bytes FROM buckets WHERE bucket_ts = ? AND topic = ?');
    const upsertStmt = db.prepare(
        `INSERT INTO buckets (bucket_ts, topic, blob, count, bytes) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(bucket_ts, topic) DO UPDATE SET blob=excluded.blob, count=excluded.count, bytes=excluded.bytes`
    );
    const insertIndexStmt = db.prepare(
        `INSERT INTO history_messages (bucket_ts, topic, msg_index, time_ms, search_text, payload_offset, payload_len, entry_offset, entry_len)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertFtsStmt = ftsTokenizer === 'none'
        ? null
        : db.prepare(
            `INSERT INTO history_messages_fts (search_text, bucket_ts, topic, msg_index, time_ms)
             VALUES (?, ?, ?, ?, ?)`
        );
    const deleteFtsStmt = ftsTokenizer === 'none'
        ? null
        : db.prepare('DELETE FROM history_messages_fts WHERE bucket_ts = ? AND topic = ?');
    const countIndexStmt = db.prepare('SELECT COUNT(*) AS count FROM history_messages WHERE bucket_ts = ? AND topic = ?');
    const insertBackupStmt = db.prepare(
        `INSERT INTO bucket_blob_backups (bucket_ts, topic, saved_at, reason, blob, count, bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const pack: LogDbPack = { db, getStmt, upsertStmt, insertIndexStmt, insertFtsStmt, deleteFtsStmt, countIndexStmt, insertBackupStmt };
    logDbCache.set(key, pack);
    return pack;
}

// ---------------- lifecycle ----------------
export function pauseStorageWrites(reason = 'maintenance'): void {
    if (USE_STORAGE_WORKER) {
        flushStorageWorkerBatch();
        postStorageWorker('pause', { reason });
    }
    maintenancePauseDepth++;
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    clearStorageWorkerBatchTimer();
}

export function resumeStorageWrites(reason = 'maintenance'): void {
    if (maintenancePauseDepth > 0) maintenancePauseDepth--;
    if (USE_STORAGE_WORKER) postStorageWorker('resume', { reason });
    if (maintenancePauseDepth === 0 && pending.length > 0) scheduleFlush();
}

export function withStorageMaintenance<T>(fn: () => T): T {
    pauseStorageWrites();
    try {
        flushStorageLocal();
        return fn();
    } finally {
        resumeStorageWrites();
    }
}

function enqueueStorageWorkerBatch(entry: PendingEntry, estimatedBytes: number): void {
    if (storageWorkerFailure) {
        if (!storageWorkerFailureLogged) failStorageWorker(storageWorkerFailure);
        return;
    }
    storageWorkerBatch.push(entry);
    storageWorkerBatchBytes += estimatedBytes;
    if (storageWorkerBatch.length >= STORAGE_WORKER_BATCH_ENTRIES || storageWorkerBatchBytes >= STORAGE_WORKER_BATCH_BYTES) {
        flushStorageWorkerBatch();
        return;
    }
    if (maintenancePauseDepth > 0 || storageWorkerBatchTimer) return;
    storageWorkerBatchTimer = setTimeout(() => {
        storageWorkerBatchTimer = null;
        flushStorageWorkerBatch();
    }, STORAGE_WORKER_BATCH_MS);
}

function flushStorageWorkerBatch(): void {
    clearStorageWorkerBatchTimer();
    if (!USE_STORAGE_WORKER || storageWorkerBatch.length === 0) return;
    if (storageWorkerFailure) throw storageWorkerFailure;
    const batch = storageWorkerBatch.splice(0, storageWorkerBatch.length);
    storageWorkerBatchBytes = 0;
    if (!postStorageWorker('enqueueBatch', batch)) {
        throw storageWorkerUnavailableError();
    }
}

// ---------------- flush ----------------
export function stopAcceptingStorageWrites(): void {
    storageAcceptingWrites = false;
    clearStorageWorkerBatchTimer();
}

export function enqueueMessage(connectionId: string, topic: string, payload: string, tsMs: number, meta: Partial<BucketItem> = {}): void {
    if (!storageAcceptingWrites || !connectionId) return;
    const payloadSize = meta.payloadSize ?? meta.payloadBytes?.byteLength ?? payload.length;
    const entry = { connectionId, topic, payload, tsMs, ...meta, payloadSize };
    const estimatedBytes = payloadSize + topic.length + 16;
    if (USE_STORAGE_WORKER) {
        enqueueStorageWorkerBatch(entry, estimatedBytes);
        return;
    }
    pending.push(entry);
    pendingBytes += estimatedBytes;
    if (pending.length >= STORAGE_HARD_ENTRIES || pendingBytes >= STORAGE_FLUSH_BYTES) {
        flushStorageLocal();
    } else {
        scheduleFlush();
    }
}

function scheduleFlush(): void {
    if (maintenancePauseDepth > 0) return;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushStorageLocal();
    }, STORAGE_FLUSH_MS);
}

function requeueGroups(groups: Map<string, { connectionId: string; sec: number; topic: string; items: BucketItem[] }>): void {
    const retry: PendingEntry[] = [];
    for (const g of groups.values()) {
        for (const item of g.items) {
            retry.push({ connectionId: g.connectionId, topic: g.topic, ...item });
            pendingBytes += (item.payloadSize ?? item.payloadBytes?.byteLength ?? item.payload.length) + g.topic.length + 16;
        }
    }
    if (retry.length > 0) pending.unshift(...retry);
}

/** 按 (san, dk, sec, topic) 聚合 pending，然后对每个 day.db 开一个事务批量 UPSERT */
export function flushStorage(): void {
    if (USE_STORAGE_WORKER) {
        console.warn('[storage] sync flush requested while storage worker is enabled; use flushStorageAsync for a durable barrier');
        return;
    }
    flushStorageLocal();
}

export async function flushStorageAsync(): Promise<void> {
    if (USE_STORAGE_WORKER) {
        flushStorageWorkerBatch();
        await callStorageWorker('flush');
        return;
    }
    flushStorageLocal();
}

function flushStorageLocal(): void {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    pendingBytes = 0;

    // 分组：dayKey -> (sec|topic -> items[])
    const byDay = new Map<string, Map<string, { connectionId: string; sec: number; topic: string; items: BucketItem[] }>>();

    for (let i = 0; i < batch.length; i++) {
        const e = batch[i];
        const san = sanitizeConnectionId(e.connectionId);
        const dk = dateKeyFromTs(e.tsMs);
        const sec = Math.floor(e.tsMs / 1000);
        const dayKey = `${san}|${dk}`;
        let m = byDay.get(dayKey);
        if (!m) { m = new Map(); byDay.set(dayKey, m); }
        const bk = `${sec}|${e.topic}`;
        let g = m.get(bk);
        if (!g) { g = { connectionId: e.connectionId, sec, topic: e.topic, items: [] }; m.set(bk, g); }
        g.items.push({ payload: e.payload, tsMs: e.tsMs });
    }

    for (const [dayKey, groups] of byDay) {
        const pipe = dayKey.indexOf('|');
        const san = dayKey.slice(0, pipe);
        const dk = dayKey.slice(pipe + 1);
        try {
            const pack = getOrOpenLogDb(san, dk);
            const indexSchemaVersion = getCompleteHistoryIndexVersion(pack.db);
            const wasIndexComplete = Boolean(indexSchemaVersion);
            let indexFailed = false;
            let indexedMessageDelta = 0;
            let indexedBucketDelta = 0;
            const txn = pack.db.transaction(() => {
                for (const g of groups.values()) {
                    const existing = pack.getStmt.get(g.sec, g.topic) as ExistingBucketRow | undefined;
                    let startIndex = 0;
                    let nextBlob: Buffer | null = null;
                    let isNewBucket = false;
                    let canAppendIndex = wasIndexComplete && !indexFailed;

                    if (existing) {
                        const validation = validateBucketBlob(existing.blob, existing.count, existing.bytes);
                        if (validation.valid) {
                            startIndex = validation.count;
                            const next = appendEntriesToBucketBlob(existing.blob, validation.count, g.items, g.sec);
                            nextBlob = next.blob;
                            pack.upsertStmt.run(g.sec, g.topic, next.blob, next.count, next.bytes);
                            if (canAppendIndex) {
                                const indexRow = pack.countIndexStmt.get(g.sec, g.topic) as { count: number } | undefined;
                                if ((indexRow?.count ?? 0) !== startIndex) {
                                    canAppendIndex = false;
                                    const entries = iterateBucketEntries(next.blob, g.sec);
                                    try {
                                        replaceBucketIndex(pack, g.sec, g.topic, entries);
                                        refreshIndexedCounts(pack.db);
                                        indexedMessageDelta = 0;
                                        indexedBucketDelta = 0;
                                    } catch (error) {
                                        indexFailed = true;
                                        console.error('[storage] repair bucket index', dayKey, g.topic, error);
                                    }
                                }
                            }
                        } else {
                            indexFailed = true;
                            canAppendIndex = false;
                            if (Buffer.isBuffer(existing.blob)) {
                                backupBucketBlob(pack, g.sec, g.topic, existing, validation.reason);
                            }
                            if (validation.structureValid && Buffer.isBuffer(existing.blob)) {
                                const next = appendEntriesToBucketBlob(existing.blob, validation.count, g.items, g.sec);
                                nextBlob = next.blob;
                                pack.upsertStmt.run(g.sec, g.topic, next.blob, next.count, next.bytes);
                            } else {
                                const oldItems = Buffer.isBuffer(existing.blob)
                                    ? decodeBucket(existing.blob, g.sec, g.topic).map((m) => ({ payload: m.payload, tsMs: m.time }))
                                    : [];
                                const items = [...oldItems, ...g.items];
                                const blob = encodeBucket(items, g.sec);
                                nextBlob = blob;
                                pack.upsertStmt.run(g.sec, g.topic, blob, items.length, blob.length);
                            }
                            console.warn('[storage] rewrite suspicious bucket', dayKey, g.topic, validation.reason);
                        }
                    } else {
                        isNewBucket = true;
                        const blob = encodeBucket(g.items, g.sec);
                        nextBlob = blob;
                        pack.upsertStmt.run(g.sec, g.topic, blob, g.items.length, blob.length);
                    }

                    if (!canAppendIndex || !nextBlob || !indexSchemaVersion) continue;
                    try {
                        const entries = iterateBucketEntries(nextBlob, g.sec).slice(startIndex);
                        appendBucketIndex(pack.insertIndexStmt, pack.insertFtsStmt, g.sec, g.topic, entries);
                        indexedMessageDelta += entries.length;
                        if (isNewBucket) indexedBucketDelta++;
                    } catch (error) {
                        indexFailed = true;
                        console.error('[storage] append bucket index', dayKey, g.topic, error);
                    }
                }
                if (indexFailed) {
                    markIndexDirty(pack.db);
                } else if (wasIndexComplete) {
                    incrementIndexMeta(pack.db, 'indexed_message_count', indexedMessageDelta);
                    incrementIndexMeta(pack.db, 'indexed_bucket_count', indexedBucketDelta);
                    if (indexedMessageDelta > 0) setIndexMeta(pack.db, 'last_indexed_at', Date.now());
                } else {
                    markIndexDirty(pack.db);
                }
            });
            txn();
        } catch (e) {
            requeueGroups(groups);
            scheduleFlush();
            console.error('[storage] flush day', dayKey, e);
        }
    }
}

// ---------------- read ----------------
function listDayFiles(san: string, descending: boolean): string[] {
    const dir = path.join(LOG_ROOT, san);
    if (!fs.existsSync(dir)) return [];
    const keys = fs.readdirSync(dir).filter((f) => DATE_KEY_FILE_RE.test(f));
    keys.sort();
    if (descending) keys.reverse();
    return keys.map((k) => path.join(dir, k));
}

export function readRecentByConnection(connectionId: string, limit = 5000): HistoryMessage[] {
    flushStorageLocal();
    if (!connectionId) return [];
    const san = sanitizeConnectionId(connectionId);
    const files = listDayFiles(san, true);
    const out: HistoryMessage[] = [];
    const bucketChunkSize = 256;
    for (const fp of files) {
        if (out.length >= limit) break;
        const db = new Database(fp, { readonly: true });
        try {
            const firstStmt = db.prepare(
                'SELECT bucket_ts, topic, blob FROM buckets ORDER BY bucket_ts DESC, topic DESC LIMIT ?'
            );
            const nextStmt = db.prepare(
                `SELECT bucket_ts, topic, blob
                 FROM buckets
                 WHERE bucket_ts < ? OR (bucket_ts = ? AND topic < ?)
                 ORDER BY bucket_ts DESC, topic DESC
                 LIMIT ?`
            );
            let lastBucketTs: number | null = null;
            let lastTopic: string | null = null;
            while (out.length < limit) {
                const rows = (lastBucketTs == null || lastTopic == null
                    ? firstStmt.all(bucketChunkSize)
                    : nextStmt.all(lastBucketTs, lastBucketTs, lastTopic, bucketChunkSize)) as {
                    bucket_ts: number; topic: string; blob: Buffer;
                }[];
                if (rows.length === 0) break;
                for (const r of rows) {
                    const arr = decodeBucket(r.blob, r.bucket_ts, r.topic);
                    for (let j = arr.length - 1; j >= 0; j--) {
                        arr[j].connectionId = connectionId;
                        out.push(arr[j]);
                        if (out.length >= limit) break;
                    }
                    if (out.length >= limit) break;
                }
                const tail = rows[rows.length - 1];
                lastBucketTs = tail.bucket_ts;
                lastTopic = tail.topic;
            }
        } finally {
            db.close();
        }
    }
    return out;
}

export function queryHistory(opts: HistoryQueryOptions): HistoryMessage[] {
    flushStorageLocal();
    const st = opts.startTime != null && opts.startTime > 0 ? opts.startTime : -8640000000000000;
    const et = opts.endTime != null && opts.endTime > 0 ? opts.endTime : 8640000000000000;
    const limit = Math.min(500_000, Math.max(1, opts.limit ?? 500));
    const offset = Math.max(0, opts.offset ?? 0);
    const order = opts.order === 'asc' ? 'asc' : 'desc';
    const conditions = normalizeConditions(opts.conditions);
    const terms = conditions.length ? [] : parseKeywordTerms(opts.keywords?.length ? opts.keywords : (opts.keyword ? [opts.keyword] : []));
    const keywordLogic = opts.keywordLogic === 'or' ? 'or' : 'and';
    const topicFilter = opts.topic && opts.topic.trim() ? opts.topic.trim() : null;

    const files: { path: string; dk: string; san: string }[] = [];
    if (!fs.existsSync(LOG_ROOT)) return [];

    const sanFilter = opts.connectionId ? sanitizeConnectionId(opts.connectionId) : null;
    const dirs = fs.readdirSync(LOG_ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory() && (!sanFilter || d.name === sanFilter));

    for (const d of dirs) {
        const dir = path.join(LOG_ROOT, d.name);
        const dayFiles = fs.readdirSync(dir).filter((f) => DATE_KEY_FILE_RE.test(f));
        for (const df of dayFiles) {
            const dk = df.replace('.db', '');
            if (dayEndTsFromKey(dk) < st || dayStartTsFromKey(dk) > et) continue;
            files.push({ path: path.join(dir, df), dk, san: d.name });
        }
    }
    files.sort((a, b) => order === 'desc'
        ? (a.dk < b.dk ? 1 : a.dk > b.dk ? -1 : 0)
        : (a.dk < b.dk ? -1 : a.dk > b.dk ? 1 : 0));

    const secMin = Math.floor(Math.max(st, -8640000000) / 1000);
    const secMax = Math.ceil(Math.min(et, 8640000000000) / 1000);
    const bucketChunkSize = 256;
    const out: HistoryMessage[] = [];
    let skipped = 0;

    for (const fe of files) {
        if (out.length >= limit) break;
        const db = new Database(fe.path, { readonly: true });
        try {
            let lastBucketTs: number | null = null;
            let lastTopic: string | null = null;
            while (out.length < limit) {
                let sql = 'SELECT bucket_ts, topic, blob FROM buckets WHERE bucket_ts BETWEEN ? AND ?';
                const params: (number | string)[] = [secMin, secMax];
                if (topicFilter) {
                    sql += ' AND topic = ?';
                    params.push(topicFilter);
                }
                if (lastBucketTs != null && lastTopic != null) {
                    if (order === 'desc') {
                        sql += ' AND (bucket_ts < ? OR (bucket_ts = ? AND topic < ?))';
                    } else {
                        sql += ' AND (bucket_ts > ? OR (bucket_ts = ? AND topic > ?))';
                    }
                    params.push(lastBucketTs, lastBucketTs, lastTopic);
                }
                sql += order === 'desc'
                    ? ' ORDER BY bucket_ts DESC, topic DESC LIMIT ?'
                    : ' ORDER BY bucket_ts ASC, topic ASC LIMIT ?';
                params.push(bucketChunkSize);

                const rows = db.prepare(sql).all(...params) as { bucket_ts: number; topic: string; blob: Buffer }[];
                if (rows.length === 0) break;

                for (const r of rows) {
                    const decoded = decodeBucket(r.blob, r.bucket_ts, r.topic);
                    const start = order === 'desc' ? decoded.length - 1 : 0;
                    const end = order === 'desc' ? -1 : decoded.length;
                    const step = order === 'desc' ? -1 : 1;
                    for (let j = start; j !== end; j += step) {
                        const m = decoded[j];
                        if (m.time < st || m.time > et) continue;
                        if (!matchesText(m.topic, m.payload, conditions, terms, keywordLogic)) continue;
                        if (skipped < offset) {
                            skipped++;
                            continue;
                        }
                        m.connectionId = fe.san;
                        out.push(m);
                        if (out.length >= limit) break;
                    }
                    if (out.length >= limit) break;
                }

                const tail = rows[rows.length - 1];
                lastBucketTs = tail.bucket_ts;
                lastTopic = tail.topic;
            }
        } finally {
            db.close();
        }
    }
    return out;
}

export function getHistoryIndexStatus(connectionId?: string | null): HistoryIndexStatus {
    flushStorageLocal();
    const status: HistoryIndexStatus = {
        totalFiles: 0,
        indexedFiles: 0,
        incompleteFiles: 0,
        totalMessages: 0,
        fts5Enabled: false
    };
    if (!fs.existsSync(LOG_ROOT)) return status;
    const sanFilter = connectionId ? sanitizeConnectionId(connectionId) : null;
    const dirs = fs.readdirSync(LOG_ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory() && (!sanFilter || d.name === sanFilter));
    for (const d of dirs) {
        const dir = path.join(LOG_ROOT, d.name);
        const files = fs.readdirSync(dir).filter((f) => DATE_KEY_FILE_RE.test(f));
        for (const file of files) {
            status.totalFiles++;
            const db = new Database(path.join(dir, file), { readonly: true });
            try {
                const complete = getIndexMeta(db, 'index_complete') === '1';
                const version = getHistoryIndexSchemaVersion(db);
                if (complete && version) status.indexedFiles++;
                else status.incompleteFiles++;
                if (getIndexMeta(db, 'fts5_enabled') === '1') status.fts5Enabled = true;
                const indexedCount = Number(getIndexMeta(db, 'indexed_message_count') || 0);
                if (Number.isFinite(indexedCount) && indexedCount > 0) status.totalMessages += indexedCount;
            } catch {
                status.incompleteFiles++;
            } finally {
                db.close();
            }
        }
    }
    return status;
}

// ---------------- clear ----------------
function closeLogDbsForSan(san: string): void {
    for (const [k, v] of [...logDbCache.entries()]) {
        if (k.startsWith(`${san}|`)) {
            try { v.db.close(); } catch {}
            logDbCache.delete(k);
        }
    }
}

function countDayDbFiles(dir: string): number {
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter((f) => DATE_KEY_FILE_RE.test(f) || /^\d{4}-\d{2}-\d{2}\.db(?:-wal|-shm)$/u.test(f)).length;
}

function closeOldLogDbs(cutoff: number): void {
    for (const [key, pack] of [...logDbCache.entries()]) {
        const pipe = key.lastIndexOf('|');
        const dk = pipe >= 0 ? key.slice(pipe + 1) : '';
        if (!dk) continue;
        const dayEnd = dayEndTsFromKey(dk);
        if (Number.isFinite(dayEnd) && dayEnd < cutoff) {
            try { pack.db.close(); } catch {}
            logDbCache.delete(key);
        }
    }
}

export function closeAllLogDbs(): void {
    flushStorageLocal();
    for (const [, v] of logDbCache) { try { v.db.close(); } catch {} }
    logDbCache.clear();
}

export async function closeAllLogDbsAsync(): Promise<void> {
    if (USE_STORAGE_WORKER) {
        flushStorageWorkerBatch();
        await callStorageWorker('closeAll');
        return;
    }
    closeAllLogDbs();
}

export function clearLogs(connectionId?: string | null): { deletedFiles: number } {
    return withStorageMaintenance(() => {
        let deleted = 0;
        if (connectionId) {
            const san = sanitizeConnectionId(connectionId);
            closeLogDbsForSan(san);
            const dir = path.join(LOG_ROOT, san);
            if (fs.existsSync(dir)) {
                deleted = countDayDbFiles(dir);
                fs.rmSync(dir, { recursive: true, force: true });
            }
        } else {
            closeAllLogDbs();
            if (fs.existsSync(LOG_ROOT)) {
                const subs = fs.readdirSync(LOG_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
                for (const s of subs) deleted += countDayDbFiles(path.join(LOG_ROOT, s.name));
                fs.rmSync(LOG_ROOT, { recursive: true, force: true });
            }
            fs.mkdirSync(LOG_ROOT, { recursive: true });
        }
        return { deletedFiles: deleted };
    });
}

export function clearLogsWithoutConnections(connectionIds: string[]): { deletedFiles: number; deletedDirs: number } {
    return withStorageMaintenance(() => {
        const valid = new Set(connectionIds.filter(Boolean).map((id) => sanitizeConnectionId(id)));
        let deletedDirs = 0;
        if (!fs.existsSync(LOG_ROOT)) return { deletedFiles: 0, deletedDirs };
        const dirs = fs.readdirSync(LOG_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
        for (const d of dirs) {
            if (valid.has(d.name)) continue;
            closeLogDbsForSan(d.name);
            fs.rmSync(path.join(LOG_ROOT, d.name), { recursive: true, force: true });
            deletedDirs++;
        }
        return { deletedFiles: 0, deletedDirs };
    });
}

export async function clearLogsAsync(connectionId?: string | null): Promise<{ deletedFiles: number }> {
    if (!USE_STORAGE_WORKER) return clearLogs(connectionId);
    pauseStorageWrites('clear-logs');
    try {
        await closeAllLogDbsAsync();
        let deleted = 0;
        if (connectionId) {
            const san = sanitizeConnectionId(connectionId);
            const dir = path.join(LOG_ROOT, san);
            if (fs.existsSync(dir)) {
                deleted = countDayDbFiles(dir);
                fs.rmSync(dir, { recursive: true, force: true });
            }
        } else {
            if (fs.existsSync(LOG_ROOT)) {
                const subs = fs.readdirSync(LOG_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
                for (const s of subs) deleted += countDayDbFiles(path.join(LOG_ROOT, s.name));
                fs.rmSync(LOG_ROOT, { recursive: true, force: true });
            }
            fs.mkdirSync(LOG_ROOT, { recursive: true });
        }
        return { deletedFiles: deleted };
    } finally {
        resumeStorageWrites('clear-logs');
    }
}

export async function clearLogsWithoutConnectionsAsync(connectionIds: string[]): Promise<{ deletedFiles: number; deletedDirs: number }> {
    if (!USE_STORAGE_WORKER) return clearLogsWithoutConnections(connectionIds);
    pauseStorageWrites('clear-stale-logs');
    try {
        await closeAllLogDbsAsync();
        const valid = new Set(connectionIds.filter(Boolean).map((id) => sanitizeConnectionId(id)));
        let deletedDirs = 0;
        if (!fs.existsSync(LOG_ROOT)) return { deletedFiles: 0, deletedDirs };
        const dirs = fs.readdirSync(LOG_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
        for (const d of dirs) {
            if (valid.has(d.name)) continue;
            fs.rmSync(path.join(LOG_ROOT, d.name), { recursive: true, force: true });
            deletedDirs++;
        }
        return { deletedFiles: 0, deletedDirs };
    } finally {
        resumeStorageWrites('clear-stale-logs');
    }
}

export async function purgeNonCurrentHistoryIndexDbsAsync(): Promise<{ deletedFiles: number }> {
    if (!USE_STORAGE_WORKER) {
        return withStorageMaintenance(() => ({ deletedFiles: purgeNonCurrentHistoryIndexDbs() }));
    }
    pauseStorageWrites('purge-old-history-indexes');
    try {
        await closeAllLogDbsAsync();
        return { deletedFiles: purgeNonCurrentHistoryIndexDbs() };
    } finally {
        resumeStorageWrites('purge-old-history-indexes');
    }
}

// ---------------- cleanup ----------------
export function runAutoDeleteAsync(days: number, onDone: (files: number) => void, onFinish?: () => void): void {
    if (days <= 0) {
        onFinish?.();
        return;
    }
    const cutoff = Date.now() - days * 86_400_000;
    pauseStorageWrites('auto-delete');
    flushStorageLocal();
    closeOldLogDbs(cutoff);
    const workerPath = path.join(__dirname, 'auto-delete-worker.js');
    const w = new Worker(workerPath, { workerData: { logRoot: LOG_ROOT, cutoff } });
    autoDeleteWorkers.add(w);
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        autoDeleteWorkers.delete(w);
        resumeStorageWrites('auto-delete');
        onFinish?.();
    };
    w.once('message', (msg: { removed: number; error?: string }) => {
        if (msg.error) console.error('[storage] auto-delete worker:', msg.error);
        if (msg.removed > 0) onDone(msg.removed);
        finish();
    });
    w.once('error', (e: Error) => {
        console.error('[storage] auto-delete worker err:', e);
        finish();
    });
    w.once('exit', finish);
}

export async function stopAutoDeleteWorkers(): Promise<void> {
    const workers = [...autoDeleteWorkers];
    autoDeleteWorkers.clear();
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => undefined)));
}

export function shutdownStorage(): void {
    if (USE_STORAGE_WORKER) {
        void shutdownStorageAsync();
        return;
    }
    closeAllLogDbs();
}

export async function shutdownStorageAsync(): Promise<void> {
    storageAcceptingWrites = false;
    if (USE_STORAGE_WORKER) {
        clearStorageWorkerBatchTimer();
        if (storageWorkerFailure) {
            storageWorkerBatch.splice(0, storageWorkerBatch.length);
            storageWorkerBatchBytes = 0;
            return;
        }
        if (storageWorker) {
            storageWorkerShuttingDown = true;
            try {
                flushStorageWorkerBatch();
                await callStorageWorker('shutdown', undefined, STORAGE_WORKER_SHUTDOWN_TIMEOUT_MS).catch((error) => {
                    console.warn('[storage] worker shutdown timed out; forcing terminate:', error);
                });
            } finally {
                const worker = storageWorker;
                storageWorker = null;
                storageWorkerBatch.splice(0, storageWorkerBatch.length);
                storageWorkerBatchBytes = 0;
                await worker?.terminate().catch(() => undefined);
                rejectStorageWorkerRequests(new Error('storage worker shutdown'));
                storageWorkerShuttingDown = false;
            }
            return;
        }
    }
    closeAllLogDbs();
}
