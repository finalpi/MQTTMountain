import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import type { HistoryMessage, HistoryQueryOptions } from '../../shared/types';

const DATE_KEY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.db$/;

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

function matchesConditions(hay: string, conditions: NonNullable<HistoryQueryOptions['conditions']>): boolean {
    const active = conditions
        .map((item) => ({ join: item.join, term: normalizeKeyword(item.term) }))
        .filter((item) => item.term);
    if (active.length === 0) return true;
    let result = hay.includes(active[0].term);
    for (let i = 1; i < active.length; i++) {
        const item = active[i];
        const hit = hay.includes(item.term);
        if (item.join === 'or') result = result || hit;
        else if (item.join === 'not') result = result && !hit;
        else result = result && hit;
    }
    return result;
}

function queryHistory(): HistoryMessage[] {
    const st = opts.startTime != null && opts.startTime > 0 ? opts.startTime : -8640000000000000;
    const et = opts.endTime != null && opts.endTime > 0 ? opts.endTime : 8640000000000000;
    const limit = Math.min(500_000, Math.max(1, opts.limit ?? 500));
    const offset = Math.max(0, opts.offset ?? 0);
    const conditions = opts.conditions?.length ? opts.conditions : null;
    const terms = conditions ? [] : parseKeywordTerms(opts.keywords?.length ? opts.keywords : (opts.keyword ? [opts.keyword] : []));
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
    files.sort((a, b) => (a.dk < b.dk ? 1 : a.dk > b.dk ? -1 : 0));

    const secMin = Math.floor(Math.max(st, -8640000000) / 1000);
    const secMax = Math.ceil(Math.min(et, 8640000000000) / 1000);
    const out: HistoryMessage[] = [];
    let skipped = 0;

    for (const fe of files) {
        if (out.length >= limit) break;
        const db = new Database(fe.path, { readonly: true });
        try {
            let sql = 'SELECT bucket_ts, topic, blob FROM buckets WHERE bucket_ts BETWEEN ? AND ?';
            const params: Array<number | string> = [secMin, secMax];
            if (topicFilter) {
                sql += ' AND topic = ?';
                params.push(topicFilter);
            }
            sql += ' ORDER BY bucket_ts DESC, topic DESC';
            const rows = db.prepare(sql).iterate(...params) as Iterable<{ bucket_ts: number; topic: string; blob: Buffer }>;

            for (const r of rows) {
                if (out.length >= limit) break;
                const decoded = decodeBucket(r.blob, r.bucket_ts, r.topic);
                for (let j = decoded.length - 1; j >= 0; j--) {
                    const m = decoded[j];
                    if (m.time < st || m.time > et) continue;
                    if (conditions || terms.length) {
                        const hay = (m.topic + m.payload).replace(/\s+/gu, '').toLowerCase();
                        if (conditions) {
                            if (!matchesConditions(hay, conditions)) continue;
                        } else {
                            const hit = keywordLogic === 'or'
                                ? terms.some((term) => hay.includes(term))
                                : terms.every((term) => hay.includes(term));
                            if (!hit) continue;
                        }
                    }
                    if (skipped < offset) {
                        skipped++;
                        continue;
                    }
                    m.connectionId = fe.san;
                    out.push(m);
                    if (out.length >= limit) break;
                }
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
