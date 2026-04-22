/**
 * 分片存储（B 方案 · 每秒合批）
 * 结构：
 *   <logRoot>/<sanitizedConnectionId>/<YYYY-MM-DD>.db
 *   table buckets:
 *     bucket_ts   INTEGER   -- 秒级时间戳 (second precision)
 *     topic       TEXT
 *     blob        BLOB      -- 长度前缀拼接：[u32 count][u32 len1][bytes1][u32 len2][bytes2]...
 *     count       INTEGER
 *     bytes       INTEGER
 *     PRIMARY KEY(bucket_ts, topic)
 *
 * 写入策略：主进程把单条消息入内存合并器 pendingBuckets，按 (ts_sec, topic) 聚合；
 *   每 STORAGE_FLUSH_MS 或 pending 总 payload 超过 STORAGE_FLUSH_BYTES 后，序列化成 Buffer 并 UPSERT 到对应 day.db。
 *   如果同一 (ts_sec, topic) 已存在，采用 append：读取旧 blob、拼接、写回，一次事务完成。
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { HistoryMessage, HistoryQueryOptions } from '../../shared/types';

const DATE_KEY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.db$/;
const MAX_OPEN_LOG_DBS = 24;

let LOG_ROOT = '';
const logDbCache = new Map<string, { db: Database.Database; getStmt: Database.Statement; upsertStmt: Database.Statement }>();

/** 单条消息条目（尚未合批） */
interface PendingEntry {
    connectionId: string;
    topic: string;
    payload: string;
    tsMs: number;
}

const pending: PendingEntry[] = [];
let pendingBytes = 0;
let flushTimer: NodeJS.Timeout | null = null;
const STORAGE_FLUSH_MS = 250;
const STORAGE_FLUSH_BYTES = 4 * 1024 * 1024;
const STORAGE_HARD_ENTRIES = 20_000;

export function initStorage(logRoot: string): void {
    LOG_ROOT = logRoot;
    fs.mkdirSync(LOG_ROOT, { recursive: true });
}

export function getLogRoot(): string {
    return LOG_ROOT;
}

function sanitizeConnectionId(id: string): string {
    if (!id) return '_none';
    const s = String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
    return s.length > 120 ? s.slice(0, 120) : s || '_empty';
}

function dateKeyFromTs(tsMs: number): string {
    const d = new Date(tsMs);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function dayStartTsFromKey(dk: string): number {
    const [y, mo, da] = dk.split('-').map(Number);
    return new Date(y, mo - 1, da, 0, 0, 0, 0).getTime();
}
function dayEndTsFromKey(dk: string): number {
    return dayStartTsFromKey(dk) + 86_400_000 - 1;
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

function getOrOpenLogDb(san: string, dk: string) {
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
    `);
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
    const pack = { db, getStmt, upsertStmt };
    logDbCache.set(key, pack);
    return pack;
}

// ---------------- encode / decode ----------------
/** 编码：[u32 count][u32 firstTsOffsetMs relative to bucketSec*1000][u32 len1][bytes1][i32 tsOffset2][u32 len2][bytes2]... */
function encodeBucket(items: { payload: string; tsMs: number }[], bucketSec: number): Buffer {
    const base = bucketSec * 1000;
    const buffers: Buffer[] = [];
    const head = Buffer.alloc(4);
    head.writeUInt32LE(items.length, 0);
    buffers.push(head);
    for (const it of items) {
        const off = Math.max(0, Math.min(65535, it.tsMs - base));
        const data = Buffer.from(it.payload, 'utf8');
        const meta = Buffer.alloc(6);
        meta.writeUInt16LE(off, 0);
        meta.writeUInt32LE(data.length, 2);
        buffers.push(meta, data);
    }
    return Buffer.concat(buffers);
}

function decodeBucket(blob: Buffer, bucketSec: number, topic: string): HistoryMessage[] {
    const out: HistoryMessage[] = [];
    if (!blob || blob.length < 4) return out;
    const base = bucketSec * 1000;
    const n = blob.readUInt32LE(0);
    let p = 4;
    for (let i = 0; i < n && p + 6 <= blob.length; i++) {
        const off = blob.readUInt16LE(p); p += 2;
        const len = blob.readUInt32LE(p); p += 4;
        if (p + len > blob.length) break;
        const payload = blob.slice(p, p + len).toString('utf8');
        p += len;
        out.push({ connectionId: '', topic, payload, time: base + off });
    }
    return out;
}

// ---------------- flush ----------------
export function enqueueMessage(connectionId: string, topic: string, payload: string, tsMs: number): void {
    if (!connectionId) return;
    pending.push({ connectionId, topic, payload, tsMs });
    pendingBytes += payload.length + topic.length + 16;
    if (pending.length >= STORAGE_HARD_ENTRIES || pendingBytes >= STORAGE_FLUSH_BYTES) {
        flushStorage();
    } else {
        scheduleFlush();
    }
}

function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushStorage();
    }, STORAGE_FLUSH_MS);
}

/** 按 (san, dk, sec, topic) 聚合 pending，然后对每个 day.db 开一个事务批量 UPSERT */
export function flushStorage(): void {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    pendingBytes = 0;

    // 分组：dayKey -> (sec|topic -> items[])
    const byDay = new Map<string, Map<string, { sec: number; topic: string; items: { payload: string; tsMs: number }[] }>>();

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
        if (!g) { g = { sec, topic: e.topic, items: [] }; m.set(bk, g); }
        g.items.push({ payload: e.payload, tsMs: e.tsMs });
    }

    for (const [dayKey, groups] of byDay) {
        const pipe = dayKey.indexOf('|');
        const san = dayKey.slice(0, pipe);
        const dk = dayKey.slice(pipe + 1);
        try {
            const pack = getOrOpenLogDb(san, dk);
            const txn = pack.db.transaction(() => {
                for (const g of groups.values()) {
                    const existing = pack.getStmt.get(g.sec, g.topic) as { blob: Buffer; count: number; bytes: number } | undefined;
                    if (existing) {
                        // append
                        const oldItems = decodeBucket(existing.blob, g.sec, g.topic).map((m) => ({ payload: m.payload, tsMs: m.time }));
                        oldItems.push(...g.items);
                        const blob = encodeBucket(oldItems, g.sec);
                        pack.upsertStmt.run(g.sec, g.topic, blob, oldItems.length, blob.length);
                    } else {
                        const blob = encodeBucket(g.items, g.sec);
                        pack.upsertStmt.run(g.sec, g.topic, blob, g.items.length, blob.length);
                    }
                }
            });
            txn();
        } catch (e) {
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
    flushStorage();
    if (!connectionId) return [];
    const san = sanitizeConnectionId(connectionId);
    const files = listDayFiles(san, true);
    const out: HistoryMessage[] = [];
    let remaining = limit;
    for (const fp of files) {
        if (remaining <= 0) break;
        const db = new Database(fp, { readonly: true });
        try {
            const rows = db.prepare('SELECT bucket_ts, topic, blob FROM buckets ORDER BY bucket_ts DESC').all() as {
                bucket_ts: number; topic: string; blob: Buffer;
            }[];
            for (const r of rows) {
                const arr = decodeBucket(r.blob, r.bucket_ts, r.topic);
                for (let j = arr.length - 1; j >= 0; j--) {
                    arr[j].connectionId = connectionId;
                    out.push(arr[j]);
                    if (out.length >= limit) break;
                }
                if (out.length >= limit) break;
            }
            remaining = limit - out.length;
        } finally {
            db.close();
        }
    }
    return out;
}

function normalizeKeyword(k: string): string {
    return String(k).replace(/\s+/gu, '').toLowerCase();
}

export function queryHistory(opts: HistoryQueryOptions): HistoryMessage[] {
    flushStorage();
    const st = opts.startTime != null && opts.startTime > 0 ? opts.startTime : -8640000000000000;
    const et = opts.endTime != null && opts.endTime > 0 ? opts.endTime : 8640000000000000;
    const limit = Math.min(500_000, Math.max(1, opts.limit ?? 500));
    const offset = Math.max(0, opts.offset ?? 0);
    const nk = opts.keyword ? normalizeKeyword(opts.keyword).trim() : '';
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
    files.sort((a, b) => (a.dk < b.dk ? 1 : a.dk > b.dk ? -1 : 0));

    const secMin = Math.floor(Math.max(st, -8640000000) / 1000);
    const secMax = Math.ceil(Math.min(et, 8640000000000) / 1000);
    const all: HistoryMessage[] = [];

    for (const fe of files) {
        const db = new Database(fe.path, { readonly: true });
        try {
            let sql = 'SELECT bucket_ts, topic, blob FROM buckets WHERE bucket_ts BETWEEN ? AND ?';
            const params: (number | string)[] = [secMin, secMax];
            if (topicFilter) { sql += ' AND topic = ?'; params.push(topicFilter); }
            sql += ' ORDER BY bucket_ts DESC';
            const rows = db.prepare(sql).all(...params) as { bucket_ts: number; topic: string; blob: Buffer }[];
            for (const r of rows) {
                const decoded = decodeBucket(r.blob, r.bucket_ts, r.topic);
                for (let j = decoded.length - 1; j >= 0; j--) {
                    const m = decoded[j];
                    if (m.time < st || m.time > et) continue;
                    if (nk) {
                        const hay = (m.topic + m.payload).replace(/\s+/gu, '').toLowerCase();
                        if (hay.indexOf(nk) < 0) continue;
                    }
                    m.connectionId = fe.san;
                    all.push(m);
                }
            }
        } finally {
            db.close();
        }
    }
    all.sort((a, b) => b.time - a.time);
    return all.slice(offset, offset + limit);
}

// ---------------- clear ----------------
export function clearLogs(connectionId?: string | null): { deletedFiles: number } {
    flushStorage();
    let deleted = 0;
    if (connectionId) {
        const san = sanitizeConnectionId(connectionId);
        for (const [k, v] of [...logDbCache.entries()]) {
            if (k.startsWith(`${san}|`)) {
                try { v.db.close(); } catch {}
                logDbCache.delete(k);
            }
        }
        const dir = path.join(LOG_ROOT, san);
        if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir).filter((f) => f.endsWith('.db'));
            deleted = files.length;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    } else {
        for (const [, v] of logDbCache) { try { v.db.close(); } catch {} }
        logDbCache.clear();
        if (fs.existsSync(LOG_ROOT)) {
            const subs = fs.readdirSync(LOG_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
            for (const s of subs) {
                const dir = path.join(LOG_ROOT, s.name);
                const files = fs.readdirSync(dir).filter((f) => f.endsWith('.db'));
                deleted += files.length;
            }
            fs.rmSync(LOG_ROOT, { recursive: true, force: true });
        }
        fs.mkdirSync(LOG_ROOT, { recursive: true });
    }
    return { deletedFiles: deleted };
}

// ---------------- cleanup ----------------
export function runAutoDeleteAsync(days: number, onDone: (files: number) => void): void {
    if (days <= 0) return;
    const cutoff = Date.now() - days * 86_400_000;
    const { Worker } = require('node:worker_threads');
    const code = `
        const fs = require('fs');
        const path = require('path');
        const { workerData, parentPort } = require('worker_threads');
        let removed = 0;
        try {
            const { logRoot, cutoff } = workerData;
            if (fs.existsSync(logRoot)) {
                const dirs = fs.readdirSync(logRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
                for (const d of dirs) {
                    const sub = path.join(logRoot, d.name);
                    const files = fs.readdirSync(sub).filter((f) => /^\\d{4}-\\d{2}-\\d{2}\\.db$/.test(f));
                    for (const f of files) {
                        const dk = f.replace(/\\.db$/, '');
                        const [y, m, dd] = dk.split('-').map(Number);
                        const dayEnd = new Date(y, m - 1, dd, 23, 59, 59, 999).getTime();
                        if (dayEnd < cutoff) {
                            try { fs.unlinkSync(path.join(sub, f)); removed++; } catch {}
                        }
                    }
                }
            }
            parentPort.postMessage({ removed });
        } catch (e) { parentPort.postMessage({ removed, error: e.message }); }
    `;
    const w = new Worker(code, { eval: true, workerData: { logRoot: LOG_ROOT, cutoff } });
    w.once('message', (msg: { removed: number; error?: string }) => {
        if (msg.error) console.error('[storage] auto-delete worker:', msg.error);
        if (msg.removed > 0) onDone(msg.removed);
    });
    w.once('error', (e: Error) => console.error('[storage] auto-delete worker err:', e));
}

export function shutdownStorage(): void {
    flushStorage();
    for (const [, v] of logDbCache) { try { v.db.close(); } catch {} }
    logDbCache.clear();
}
