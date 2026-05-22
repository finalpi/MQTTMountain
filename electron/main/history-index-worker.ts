import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import type { HistoryIndexProgress, HistoryIndexRequest, HistoryIndexResult, HistoryMessage } from '../../shared/types';

const DATE_KEY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.db$/;
const HISTORY_INDEX_SCHEMA_VERSION = '1';
const port = parentPort;

interface IndexWorkerData {
    req: HistoryIndexRequest;
    logRoot: string;
}

const { req, logRoot } = workerData as IndexWorkerData;

function sanitizeConnectionId(id: string): string {
    if (!id) return '_none';
    const s = String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
    return s.length > 120 ? s.slice(0, 120) : s || '_empty';
}

function normalizeKeyword(k: string): string {
    return String(k).replace(/\s+/gu, '').toLowerCase();
}

function normalizeSearchText(topic: string, payload: string): string {
    return `${normalizeKeyword(topic)}${normalizeKeyword(payload)}`;
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

function setIndexMeta(db: Database.Database, key: string, value: string | number): void {
    db.prepare(
        `INSERT INTO history_index_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    ).run(key, String(value));
}

function ensureHistoryIndexSchema(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS history_index_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS history_messages (
            bucket_ts INTEGER NOT NULL,
            topic TEXT NOT NULL,
            msg_index INTEGER NOT NULL,
            time_ms INTEGER NOT NULL,
            payload TEXT NOT NULL,
            search_text TEXT NOT NULL,
            PRIMARY KEY (bucket_ts, topic, msg_index)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_history_messages_time ON history_messages(time_ms);
        CREATE INDEX IF NOT EXISTS idx_history_messages_topic_time ON history_messages(topic, time_ms);
        CREATE INDEX IF NOT EXISTS idx_history_messages_time_topic ON history_messages(time_ms, topic);
    `);
    setIndexMeta(db, 'schema_version', HISTORY_INDEX_SCHEMA_VERSION);
}

function detectFts5(db: Database.Database): boolean {
    try {
        db.exec('CREATE VIRTUAL TABLE temp.__fts_probe USING fts5(x); DROP TABLE temp.__fts_probe;');
        return true;
    } catch {
        return false;
    }
}

function collectDayFiles(): { path: string; san: string; dk: string }[] {
    if (!fs.existsSync(logRoot)) return [];
    const sanFilter = req.connectionId ? sanitizeConnectionId(req.connectionId) : null;
    const dirs = fs.readdirSync(logRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && (!sanFilter || d.name === sanFilter));
    const files: { path: string; san: string; dk: string }[] = [];
    for (const d of dirs) {
        const dir = path.join(logRoot, d.name);
        for (const file of fs.readdirSync(dir).filter((f) => DATE_KEY_FILE_RE.test(f))) {
            files.push({ path: path.join(dir, file), san: d.name, dk: file.replace('.db', '') });
        }
    }
    files.sort((a, b) => a.san.localeCompare(b.san) || a.dk.localeCompare(b.dk));
    return files;
}

function sendProgress(progress: HistoryIndexProgress): void {
    port?.postMessage({ type: 'progress', progress });
}

function calcPercent(processedFiles: number, totalFiles: number): number {
    if (totalFiles <= 0) return 100;
    return Math.max(0, Math.min(99, Math.round((processedFiles / totalFiles) * 100)));
}

function buildFileIndex(file: { path: string; san: string }, progress: HistoryIndexProgress): { buckets: number; messages: number; fts5Enabled: boolean } {
    const db = new Database(file.path);
    let processedBuckets = 0;
    let processedMessages = 0;
    let fts5Enabled = false;
    try {
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.pragma('temp_store = MEMORY');
        ensureHistoryIndexSchema(db);
        fts5Enabled = detectFts5(db);
        setIndexMeta(db, 'fts5_enabled', fts5Enabled ? '1' : '0');
        setIndexMeta(db, 'index_complete', '0');
        db.exec('DELETE FROM history_messages;');

        const totalRow = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(count), 0) AS messages FROM buckets').get() as { count: number; messages: number };
        const totalBuckets = totalRow.count;
        const insertStmt = db.prepare(
            `INSERT INTO history_messages (bucket_ts, topic, msg_index, time_ms, payload, search_text)
             VALUES (?, ?, ?, ?, ?, ?)`
        );
        const rows = db.prepare('SELECT bucket_ts, topic, blob FROM buckets ORDER BY bucket_ts ASC, topic ASC').iterate() as Iterable<{ bucket_ts: number; topic: string; blob: Buffer }>;
        const writeBucket = db.transaction((row: { bucket_ts: number; topic: string; blob: Buffer }) => {
            const decoded = decodeBucket(row.blob, row.bucket_ts, row.topic);
            for (let i = 0; i < decoded.length; i++) {
                const item = decoded[i];
                insertStmt.run(row.bucket_ts, row.topic, i, item.time, item.payload, normalizeSearchText(row.topic, item.payload));
            }
            processedBuckets++;
            processedMessages += decoded.length;
        });
        let lastReport = 0;
        for (const row of rows) {
            writeBucket(row);
            const now = Date.now();
            if (now - lastReport > 300) {
                lastReport = now;
                sendProgress({
                    ...progress,
                    filePath: file.path,
                    processedBuckets: progress.processedBuckets + processedBuckets,
                    processedMessages: progress.processedMessages + processedMessages,
                    totalBuckets,
                    percent: calcPercent(progress.processedFiles, progress.totalFiles),
                    fts5Enabled,
                    message: `正在建立索引：${path.basename(file.path)}`
                });
            }
        }
        setIndexMeta(db, 'indexed_bucket_count', processedBuckets);
        setIndexMeta(db, 'indexed_message_count', processedMessages);
        setIndexMeta(db, 'last_indexed_at', Date.now());
        setIndexMeta(db, 'index_complete', '1');
        return { buckets: processedBuckets, messages: processedMessages, fts5Enabled };
    } finally {
        db.close();
    }
}

function buildIndex(): HistoryIndexResult {
    const files = collectDayFiles();
    const result: HistoryIndexResult = {
        totalFiles: files.length,
        indexedFiles: 0,
        incompleteFiles: 0,
        totalMessages: 0,
        fts5Enabled: false,
        processedFiles: 0,
        processedBuckets: 0,
        processedMessages: 0
    };
    sendProgress({
        stage: 'checking',
        connectionId: req.connectionId ?? undefined,
        processedFiles: 0,
        totalFiles: files.length,
        processedBuckets: 0,
        processedMessages: 0,
        percent: 0,
        message: '正在统计历史日志文件...'
    });

    for (const file of files) {
        try {
            const built = buildFileIndex(file, {
                stage: 'indexing',
                connectionId: req.connectionId ?? undefined,
                processedFiles: result.processedFiles,
                totalFiles: files.length,
                processedBuckets: result.processedBuckets,
                processedMessages: result.processedMessages
            });
            result.processedFiles++;
            result.indexedFiles++;
            result.processedBuckets += built.buckets;
            result.processedMessages += built.messages;
            result.totalMessages += built.messages;
            result.fts5Enabled = result.fts5Enabled || built.fts5Enabled;
            sendProgress({
                stage: 'indexing',
                connectionId: req.connectionId ?? undefined,
                filePath: file.path,
                processedFiles: result.processedFiles,
                totalFiles: files.length,
                processedBuckets: result.processedBuckets,
                processedMessages: result.processedMessages,
                percent: calcPercent(result.processedFiles, files.length),
                fts5Enabled: result.fts5Enabled,
                message: `已完成 ${result.processedFiles}/${files.length} 个历史文件`
            });
        } catch (error) {
            result.processedFiles++;
            result.incompleteFiles++;
            sendProgress({
                stage: 'error',
                connectionId: req.connectionId ?? undefined,
                filePath: file.path,
                processedFiles: result.processedFiles,
                totalFiles: files.length,
                processedBuckets: result.processedBuckets,
                processedMessages: result.processedMessages,
                percent: calcPercent(result.processedFiles, files.length),
                message: (error as Error).message || '索引建立失败'
            });
        }
    }
    sendProgress({
        stage: 'done',
        connectionId: req.connectionId ?? undefined,
        processedFiles: result.processedFiles,
        totalFiles: files.length,
        processedBuckets: result.processedBuckets,
        processedMessages: result.processedMessages,
        percent: 100,
        fts5Enabled: result.fts5Enabled,
        message: `索引完成：${result.processedMessages.toLocaleString()} 条消息`
    });
    return result;
}

try {
    port?.postMessage({ type: 'done', result: buildIndex() });
} catch (error) {
    sendProgress({
        stage: 'error',
        connectionId: req.connectionId ?? undefined,
        processedFiles: 0,
        totalFiles: 0,
        processedBuckets: 0,
        processedMessages: 0,
        percent: 100,
        message: (error as Error).message || '索引建立失败'
    });
    port?.postMessage({ type: 'error', error: (error as Error).message || '索引建立失败' });
}
