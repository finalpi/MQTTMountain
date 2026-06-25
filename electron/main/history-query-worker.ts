import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import type { HistoryMessage, HistoryQueryOptions } from '../../shared/types';
import { decodeBucket, readPayloadSlice } from './history-bucket-codec';
import {
    collectDayFiles,
    matchesSearchText,
    matchesText,
    normalizeConditions,
    parseKeywordTerms,
    type NormalizedCondition
} from './history-query-common';
import { getHistoryIndexSchemaVersion, getIndexMeta, HISTORY_INDEX_SCHEMA_VERSION } from './history-index-schema';

interface QueryWorkerData {
    opts: HistoryQueryOptions;
    logRoot: string;
    stream?: boolean;
    requestId?: string;
    chunkSize?: number;
}

interface QueryOutput {
    length: number;
    push(row: HistoryMessage): void;
}

class ArrayQueryOutput implements QueryOutput {
    readonly rows: HistoryMessage[] = [];
    get length(): number { return this.rows.length; }
    push(row: HistoryMessage): void { this.rows.push(row); }
}

class StreamQueryOutput implements QueryOutput {
    private readonly rows: HistoryMessage[] = [];
    length = 0;

    constructor(private readonly requestId: string, private readonly chunkSize: number) {}

    push(row: HistoryMessage): void {
        this.rows.push(row);
        this.length++;
        if (this.rows.length >= this.chunkSize) this.flush();
    }

    flush(): void {
        if (!this.rows.length) return;
        parentPort?.postMessage({ type: 'chunk', requestId: this.requestId, rows: this.rows.splice(0) });
    }
}

const { opts, logRoot, stream, requestId, chunkSize } = workerData as QueryWorkerData;

function getUsableIndexVersion(db: Database.Database): string | null {
    try {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'history_messages'").get();
        if (!row || getIndexMeta(db, 'index_complete') !== '1') return null;
        return getHistoryIndexSchemaVersion(db);
    } catch {
        return null;
    }
}

function queryIndexedFile(
    db: Database.Database,
    schemaVersion: string,
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
    out: QueryOutput
): void {
    const chunkSize = 1000;
    const bucketStmt = db.prepare('SELECT blob FROM buckets WHERE bucket_ts = ? AND topic = ?');
    const bucketCache = new Map<string, HistoryMessage[]>();
    let lastTime: number | null = null;
    let lastTopic: string | null = null;
    let lastMsgIndex: number | null = null;
    while (out.length < limit) {
        let sql = schemaVersion === HISTORY_INDEX_SCHEMA_VERSION
            ? 'SELECT bucket_ts, time_ms, topic, msg_index, search_text, payload_offset, payload_len FROM history_messages WHERE time_ms BETWEEN ? AND ?'
            : 'SELECT bucket_ts, time_ms, topic, msg_index, search_text FROM history_messages WHERE time_ms BETWEEN ? AND ?';
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
        const rows = db.prepare(sql).all(...params) as { bucket_ts: number; time_ms: number; topic: string; msg_index: number; search_text: string; payload_offset?: number; payload_len?: number }[];
        if (rows.length === 0) break;
        for (const row of rows) {
            if (!matchesSearchText(row.search_text, conditions, terms, keywordLogic)) continue;
            if (skippedRef.value < offset) {
                skippedRef.value++;
                continue;
            }
            const cacheKey = `${row.bucket_ts}|${row.topic}`;
            const bucket = bucketStmt.get(row.bucket_ts, row.topic) as { blob: Buffer } | undefined;
            if (!bucket) continue;
            let payload: string | null = null;
            if (schemaVersion === HISTORY_INDEX_SCHEMA_VERSION) {
                payload = readPayloadSlice(bucket.blob, row.payload_offset ?? -1, row.payload_len ?? -1);
            }
            if (payload == null) {
                let decoded = bucketCache.get(cacheKey);
                if (!decoded) {
                    decoded = decodeBucket(bucket.blob, row.bucket_ts, row.topic);
                    bucketCache.set(cacheKey, decoded);
                }
                payload = decoded[row.msg_index]?.payload ?? null;
            }
            if (payload == null) continue;
            out.push({ connectionId: fe.san, topic: row.topic, payload, time: row.time_ms });
            if (out.length >= limit) break;
        }
        const tail = rows[rows.length - 1];
        lastTime = tail.time_ms;
        lastTopic = tail.topic;
        lastMsgIndex = tail.msg_index;
        if (rows.length < chunkSize) break;
    }
}

function queryHistory(out: QueryOutput): void {
    const st = opts.startTime != null && opts.startTime > 0 ? opts.startTime : -8640000000000000;
    const et = opts.endTime != null && opts.endTime > 0 ? opts.endTime : 8640000000000000;
    const limit = Math.min(500_000, Math.max(1, opts.limit ?? 500));
    const offset = Math.max(0, opts.offset ?? 0);
    const order = opts.order === 'asc' ? 'asc' : 'desc';
    const conditions = normalizeConditions(opts.conditions);
    const terms = conditions.length ? [] : parseKeywordTerms(opts.keywords?.length ? opts.keywords : (opts.keyword ? [opts.keyword] : []));
    const keywordLogic = opts.keywordLogic === 'or' ? 'or' : 'and';
    const topicFilter = opts.topic && opts.topic.trim() ? opts.topic.trim() : null;

    const files = collectDayFiles(logRoot, { connectionId: opts.connectionId, startTime: st, endTime: et, order });

    const secMin = Math.floor(Math.max(st, -8640000000) / 1000);
    const secMax = Math.ceil(Math.min(et, 8640000000000) / 1000);
    const bucketChunkSize = 256;
    const skippedRef = { value: 0 };

    for (const fe of files) {
        if (out.length >= limit) break;
        const db = new Database(fe.path, { readonly: true });
        try {
            const indexSchemaVersion = getUsableIndexVersion(db);
            if (indexSchemaVersion) {
                queryIndexedFile(db, indexSchemaVersion, fe, st, et, topicFilter, order, conditions, terms, keywordLogic, limit, offset, skippedRef, out);
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

}

try {
    if (stream) {
        if (!requestId) throw new Error('缺少流式查询 requestId');
        const streamOut = new StreamQueryOutput(requestId, Math.min(5000, Math.max(100, chunkSize ?? 1000)));
        queryHistory(streamOut);
        streamOut.flush();
        parentPort?.postMessage({ type: 'done', requestId, total: streamOut.length, truncated: streamOut.length >= Math.min(500_000, Math.max(1, opts.limit ?? 500)) });
    } else {
        const arrayOut = new ArrayQueryOutput();
        queryHistory(arrayOut);
        parentPort?.postMessage({ type: 'done', data: arrayOut.rows });
    }
} catch (error) {
    parentPort?.postMessage({ type: 'error', requestId, error: (error as Error).message || '查询失败' });
}
