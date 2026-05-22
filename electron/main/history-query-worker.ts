import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import type { HistoryKeywordJoin, HistoryMessage, HistoryQueryOptions } from '../../shared/types';

const DATE_KEY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.db$/;
const HISTORY_INDEX_SCHEMA_VERSION = '1';

interface QueryWorkerData {
    opts: HistoryQueryOptions;
    logRoot: string;
}

const { opts, logRoot } = workerData as QueryWorkerData;

function sanitizeConnectionId(id: string): string {
    if (!id) return '_none';
    const s = String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
    return s.length > 120 ? s.slice(0, 120) : s || '_empty';
}

function dateStartTsFromKey(dk: string): number {
    const [y, mo, da] = dk.split('-').map(Number);
    return new Date(y, mo - 1, da, 0, 0, 0, 0).getTime();
}

function dateEndTsFromKey(dk: string): number {
    return dateStartTsFromKey(dk) + 86_400_000 - 1;
}

function normalizeKeyword(k: string): string {
    return String(k).replace(/\s+/gu, '').toLowerCase();
}

function parseKeywordTerms(input: string | string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const items = Array.isArray(input) ? input : [input];
    for (const part of items) {
        const term = normalizeKeyword(part);
        if (!term || seen.has(term)) continue;
        seen.add(term);
        out.push(term);
    }
    return out;
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

interface NormalizedCondition {
    join: HistoryKeywordJoin;
    term: string;
}

function normalizeConditions(conditions?: HistoryQueryOptions['conditions']): NormalizedCondition[] {
    return (conditions ?? [])
        .map((item) => ({ join: item.join, term: normalizeKeyword(item.term) }))
        .filter((item) => item.term);
}

function matchesConditions(hay: string, conditions: NormalizedCondition[]): boolean {
    if (conditions.length === 0) return true;
    let result = hay.includes(conditions[0].term);
    for (let i = 1; i < conditions.length; i++) {
        const item = conditions[i];
        const hit = hay.includes(item.term);
        if (item.join === 'or') result = result || hit;
        else if (item.join === 'not') result = result && !hit;
        else result = result && hit;
    }
    return result;
}

function matchesSearchText(hay: string, conditions: NormalizedCondition[], terms: string[], keywordLogic: 'and' | 'or'): boolean {
    if (conditions.length === 0 && terms.length === 0) return true;
    if (conditions.length) return matchesConditions(hay, conditions);
    return keywordLogic === 'or'
        ? terms.some((term) => hay.includes(term))
        : terms.every((term) => hay.includes(term));
}

function matchesText(topic: string, payload: string, conditions: NormalizedCondition[], terms: string[], keywordLogic: 'and' | 'or'): boolean {
    return matchesSearchText(`${normalizeKeyword(topic)}${normalizeKeyword(payload)}`, conditions, terms, keywordLogic);
}

function getIndexMeta(db: Database.Database, key: string): string | null {
    try {
        const row = db.prepare('SELECT value FROM history_index_meta WHERE key = ?').get(key) as { value: string } | undefined;
        return row?.value ?? null;
    } catch {
        return null;
    }
}

function hasUsableIndex(db: Database.Database): boolean {
    try {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'history_messages'").get();
        return Boolean(row)
            && getIndexMeta(db, 'schema_version') === HISTORY_INDEX_SCHEMA_VERSION
            && getIndexMeta(db, 'index_complete') === '1';
    } catch {
        return false;
    }
}

function queryIndexedFile(
    db: Database.Database,
    fe: { san: string },
    st: number,
    et: number,
    topicFilter: string | null,
    order: 'asc' | 'desc',
    conditions: NormalizedCondition[],
    terms: string[],
    keywordLogic: 'and' | 'or',
    limit: number,
    offset: number,
    skippedRef: { value: number },
    out: HistoryMessage[]
): void {
    const chunkSize = 1000;
    let lastTime: number | null = null;
    let lastTopic: string | null = null;
    let lastMsgIndex: number | null = null;
    while (out.length < limit) {
        let sql = 'SELECT time_ms, topic, msg_index, payload, search_text FROM history_messages WHERE time_ms BETWEEN ? AND ?';
        const params: Array<number | string> = [st, et];
        if (topicFilter) {
            sql += ' AND topic = ?';
            params.push(topicFilter);
        }
        if (lastTime != null && lastTopic != null && lastMsgIndex != null) {
            if (order === 'desc') {
                sql += ' AND (time_ms < ? OR (time_ms = ? AND topic < ?) OR (time_ms = ? AND topic = ? AND msg_index < ?))';
            } else {
                sql += ' AND (time_ms > ? OR (time_ms = ? AND topic > ?) OR (time_ms = ? AND topic = ? AND msg_index > ?))';
            }
            params.push(lastTime, lastTime, lastTopic, lastTime, lastTopic, lastMsgIndex);
        }
        sql += order === 'desc'
            ? ' ORDER BY time_ms DESC, topic DESC, msg_index DESC LIMIT ?'
            : ' ORDER BY time_ms ASC, topic ASC, msg_index ASC LIMIT ?';
        params.push(chunkSize);
        const rows = db.prepare(sql).all(...params) as { time_ms: number; topic: string; msg_index: number; payload: string; search_text: string }[];
        if (rows.length === 0) break;
        for (const row of rows) {
            if (!matchesSearchText(row.search_text, conditions, terms, keywordLogic)) continue;
            if (skippedRef.value < offset) {
                skippedRef.value++;
                continue;
            }
            out.push({ connectionId: fe.san, topic: row.topic, payload: row.payload, time: row.time_ms });
            if (out.length >= limit) break;
        }
        const tail = rows[rows.length - 1];
        lastTime = tail.time_ms;
        lastTopic = tail.topic;
        lastMsgIndex = tail.msg_index;
        if (rows.length < chunkSize) break;
    }
}

function queryHistory(): HistoryMessage[] {
    const st = opts.startTime != null && opts.startTime > 0 ? opts.startTime : -8640000000000000;
    const et = opts.endTime != null && opts.endTime > 0 ? opts.endTime : 8640000000000000;
    const limit = Math.min(500_000, Math.max(1, opts.limit ?? 500));
    const offset = Math.max(0, opts.offset ?? 0);
    const order = opts.order === 'asc' ? 'asc' : 'desc';
    const conditions = normalizeConditions(opts.conditions);
    const terms = conditions.length ? [] : parseKeywordTerms(opts.keywords?.length ? opts.keywords : (opts.keyword ? [opts.keyword] : []));
    const keywordLogic = opts.keywordLogic === 'or' ? 'or' : 'and';
    const topicFilter = opts.topic && opts.topic.trim() ? opts.topic.trim() : null;

    if (!fs.existsSync(logRoot)) return [];

    const sanFilter = opts.connectionId ? sanitizeConnectionId(opts.connectionId) : null;
    const files: { path: string; dk: string; san: string }[] = [];
    const dirs = fs.readdirSync(logRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && (!sanFilter || d.name === sanFilter));

    for (const d of dirs) {
        const dir = path.join(logRoot, d.name);
        const dayFiles = fs.readdirSync(dir).filter((f) => DATE_KEY_FILE_RE.test(f));
        for (const df of dayFiles) {
            const dk = df.replace('.db', '');
            if (dateEndTsFromKey(dk) < st || dateStartTsFromKey(dk) > et) continue;
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
    const skippedRef = { value: 0 };

    for (const fe of files) {
        if (out.length >= limit) break;
        const db = new Database(fe.path, { readonly: true });
        try {
            if (hasUsableIndex(db)) {
                queryIndexedFile(db, fe, st, et, topicFilter, order, conditions, terms, keywordLogic, limit, offset, skippedRef, out);
                continue;
            }
            let lastBucketTs: number | null = null;
            let lastTopic: string | null = null;
            while (out.length < limit) {
                let sql = 'SELECT bucket_ts, topic, blob FROM buckets WHERE bucket_ts BETWEEN ? AND ?';
                const params: Array<number | string> = [secMin, secMax];
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
                        if (skippedRef.value < offset) {
                            skippedRef.value++;
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

try {
    parentPort?.postMessage({ type: 'done', data: queryHistory() });
} catch (error) {
    parentPort?.postMessage({ type: 'error', error: (error as Error).message || '查询失败' });
}
