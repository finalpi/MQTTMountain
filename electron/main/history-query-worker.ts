import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import type { HistoryMessage, HistoryQueryOptions } from '../../shared/types';
import { decodeBucket, readPayloadSlice } from './history-bucket-codec';
import {
    collectDayFiles,
    matchesSearchText,
    normalizeCombinedSearchText,
    normalizeConditions,
    normalizeKeyword,
    parseKeywordTerms,
    type NormalizedCondition
} from './history-query-common';
import { getHistoryFtsTokenizer, getHistoryIndexSchemaVersion, getIndexMeta } from './history-index-schema';

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

interface IndexedMessageRow {
    bucket_ts: number;
    time_ms: number;
    topic: string;
    msg_index: number;
    search_text: string;
    payload_offset?: number;
    payload_len?: number;
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

function getIndexVersion(db: Database.Database, requireComplete: boolean): string | null {
    try {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'history_messages'").get();
        if (!row) return null;
        if (requireComplete && getIndexMeta(db, 'index_complete') !== '1') return null;
        return getHistoryIndexSchemaVersion(db);
    } catch {
        return null;
    }
}

function getUsableIndexVersion(db: Database.Database): string | null {
    return getIndexVersion(db, true);
}

function getBestEffortIndexVersion(db: Database.Database): string | null {
    return getIndexVersion(db, false);
}

function tableExists(db: Database.Database, name: string): boolean {
    const row = db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(name);
    return Boolean(row);
}

function hasFtsIndex(db: Database.Database): boolean {
    return getHistoryFtsTokenizer(db) !== 'none' && tableExists(db, 'history_messages_fts');
}

function escapeFtsPhrase(term: string): string {
    if (/^[\p{L}\p{N}_]+$/u.test(term)) return `${term}*`;
    return `"${term.replace(/"/g, '""')}"`;
}

function buildFtsMatch(conditions: NormalizedCondition[], terms: string[], keywordLogic: 'and' | 'or'): string | null {
    if (conditions.length > 0) {
        const parts: string[] = [];
        for (let i = 0; i < conditions.length; i++) {
            const item = conditions[i];
            const phrase = escapeFtsPhrase(item.term);
            if (i === 0) {
                parts.push(item.join === 'not' ? `NOT ${phrase}` : phrase);
            } else if (item.join === 'or') {
                parts.push('OR', phrase);
            } else if (item.join === 'not') {
                parts.push('NOT', phrase);
            } else {
                parts.push('AND', phrase);
            }
        }
        return parts.length ? parts.join(' ') : null;
    }
    if (terms.length === 0) return null;
    return terms.map(escapeFtsPhrase).join(keywordLogic === 'or' ? ' OR ' : ' AND ');
}

function hasShortFtsTerm(conditions: NormalizedCondition[], terms: string[]): boolean {
    const values = conditions.length > 0 ? conditions.map((item) => item.term) : terms;
    return values.some((term) => Array.from(term).length < 3);
}

function shouldUseIndexedTextScan(db: Database.Database, conditions: NormalizedCondition[], terms: string[]): boolean {
    return getHistoryFtsTokenizer(db) === 'trigram' && hasShortFtsTerm(conditions, terms);
}

function pushIndexedRow(
    db: Database.Database,
    bucketStmt: Database.Statement,
    bucketCache: Map<string, HistoryMessage[]>,
    schemaVersion: string,
    fe: { san: string },
    row: IndexedMessageRow,
    out: QueryOutput
): void {
    const bucket = bucketStmt.get(row.bucket_ts, row.topic) as { blob: Buffer } | undefined;
    if (!bucket) return;
    let payload: string | null = readPayloadSlice(bucket.blob, row.payload_offset ?? -1, row.payload_len ?? -1);
    if (payload == null) {
        const cacheKey = `${row.bucket_ts}|${row.topic}`;
        let decoded = bucketCache.get(cacheKey);
        if (!decoded) {
            decoded = decodeBucket(bucket.blob, row.bucket_ts, row.topic);
            bucketCache.set(cacheKey, decoded);
        }
        payload = decoded[row.msg_index]?.payload ?? null;
    }
    if (payload == null) return;
    out.push({ connectionId: fe.san, topic: row.topic, payload, time: row.time_ms });
}

function pushIndexedRowIfMatches(
    db: Database.Database,
    bucketStmt: Database.Statement,
    bucketCache: Map<string, HistoryMessage[]>,
    schemaVersion: string,
    fe: { san: string },
    row: IndexedMessageRow,
    conditions: NormalizedCondition[],
    terms: string[],
    keywordLogic: 'and' | 'or',
    out: QueryOutput
): void {
    const bucket = bucketStmt.get(row.bucket_ts, row.topic) as { blob: Buffer } | undefined;
    if (!bucket) return;
    let payload: string | null = readPayloadSlice(bucket.blob, row.payload_offset ?? -1, row.payload_len ?? -1);
    if (payload == null) {
        const cacheKey = `${row.bucket_ts}|${row.topic}`;
        let decoded = bucketCache.get(cacheKey);
        if (!decoded) {
            decoded = decodeBucket(bucket.blob, row.bucket_ts, row.topic);
            bucketCache.set(cacheKey, decoded);
        }
        payload = decoded[row.msg_index]?.payload ?? null;
    }
    if (payload == null) return;
    if (!matchesSearchText(normalizeCombinedSearchText(row.topic, payload), conditions, terms, keywordLogic)) return;
    out.push({ connectionId: fe.san, topic: row.topic, payload, time: row.time_ms });
}

function likeParam(term: string): string {
    return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}

function buildLikeWhere(
    column: string,
    conditions: NormalizedCondition[],
    terms: string[],
    keywordLogic: 'and' | 'or'
): { sql: string; params: string[] } | null {
    if (conditions.length > 0) {
        const params: string[] = [];
        const parts = conditions.map((item, index) => {
            params.push(likeParam(item.term));
            const expr = `${column} LIKE ? ESCAPE '\\'`;
            if (index === 0) return item.join === 'not' ? `NOT ${expr}` : expr;
            if (item.join === 'or') return `OR ${expr}`;
            if (item.join === 'not') return `AND NOT ${expr}`;
            return `AND ${expr}`;
        });
        return parts.length ? { sql: parts.join(' '), params } : null;
    }
    if (terms.length === 0) return null;
    return {
        sql: terms.map(() => `${column} LIKE ? ESCAPE '\\'`).join(keywordLogic === 'or' ? ' OR ' : ' AND '),
        params: terms.map(likeParam)
    };
}

function topicWhereForSearch(conditions: NormalizedCondition[], terms: string[], keywordLogic: 'and' | 'or'): { sql: string; params: string[] } | null {
    return buildLikeWhere('lower(topic)', conditions, terms, keywordLogic);
}

function searchTextWhereForSearch(conditions: NormalizedCondition[], terms: string[], keywordLogic: 'and' | 'or'): { sql: string; params: string[] } | null {
    return buildLikeWhere('search_text', conditions, terms, keywordLogic);
}

function rowMatchesIndexedSearch(row: IndexedMessageRow, conditions: NormalizedCondition[], terms: string[], keywordLogic: 'and' | 'or'): boolean {
    if (conditions.length === 0 && terms.length === 0) return true;
    return matchesSearchText(normalizeCombinedSearchText(row.topic, row.search_text), conditions, terms, keywordLogic);
}

function queryTopicTextIndexedFile(
    db: Database.Database,
    schemaVersion: string,
    fe: { san: string },
    st: number,
    et: number,
    order: 'asc' | 'desc',
    conditions: NormalizedCondition[],
    terms: string[],
    keywordLogic: 'and' | 'or',
    limit: number,
    offset: number,
    skippedRef: { value: number },
    seen: Set<string>,
    out: QueryOutput
): void {
    const where = topicWhereForSearch(conditions, terms, keywordLogic);
    if (!where) return;
    const chunkSize = 1000;
    const bucketStmt = db.prepare('SELECT blob FROM buckets WHERE bucket_ts = ? AND topic = ?');
    const bucketCache = new Map<string, HistoryMessage[]>();
    let lastTime: number | null = null;
    let lastTopic: string | null = null;
    let lastMsgIndex: number | null = null;
    while (out.length < limit) {
        let sql = `SELECT bucket_ts, time_ms, topic, msg_index, search_text, payload_offset, payload_len
                   FROM history_messages
                   WHERE time_ms BETWEEN ? AND ? AND (${where.sql})`;
        const params: Array<number | string> = [st, et, ...where.params];
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
        const rows = db.prepare(sql).all(...params) as IndexedMessageRow[];
        if (rows.length === 0) break;
        for (const row of rows) {
            const key = `${row.bucket_ts}|${row.topic}|${row.msg_index}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (skippedRef.value < offset) {
                skippedRef.value++;
                continue;
            }
            pushIndexedRowIfMatches(db, bucketStmt, bucketCache, schemaVersion, fe, row, conditions, terms, keywordLogic, out);
            if (out.length >= limit) break;
        }
        const tail = rows[rows.length - 1];
        lastTime = tail.time_ms;
        lastTopic = tail.topic;
        lastMsgIndex = tail.msg_index;
        if (rows.length < chunkSize) break;
    }
}

function queryTrigramFtsIndexedFile(
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
    seen: Set<string> | null,
    out: QueryOutput
): boolean {
    if (getHistoryFtsTokenizer(db) !== 'trigram' || !hasFtsIndex(db)) return false;
    const match = buildFtsMatch(conditions, terms, keywordLogic);
    if (!match) return false;
    const positiveTerms = conditions.length > 0
        ? conditions.filter((item) => item.join !== 'not').map((item) => item.term)
        : terms;
    if (positiveTerms.length === 0 || positiveTerms.some((term) => Array.from(term).length < 3)) return false;
    const chunkSize = 1000;
    const bucketStmt = db.prepare('SELECT blob FROM buckets WHERE bucket_ts = ? AND topic = ?');
    const bucketCache = new Map<string, HistoryMessage[]>();
    let lastTime: number | null = null;
    let lastTopic: string | null = null;
    let lastMsgIndex: number | null = null;
    while (out.length < limit) {
        let sql = `SELECT m.bucket_ts, m.time_ms, m.topic, m.msg_index, m.search_text, m.payload_offset, m.payload_len
                   FROM history_messages_fts
                   JOIN history_messages m
                     ON m.bucket_ts = history_messages_fts.bucket_ts AND m.topic = history_messages_fts.topic AND m.msg_index = history_messages_fts.msg_index
                   WHERE history_messages_fts MATCH ? AND m.time_ms BETWEEN ? AND ?`;
        const params: Array<number | string> = [match, st, et];
        if (topicFilter) {
            sql += ' AND m.topic = ?';
            params.push(topicFilter);
        }
        if (lastTime != null && lastTopic != null && lastMsgIndex != null) {
            if (order === 'desc') {
                sql += ' AND (m.time_ms < ? OR (m.time_ms = ? AND m.topic < ?) OR (m.time_ms = ? AND m.topic = ? AND m.msg_index < ?))';
            } else {
                sql += ' AND (m.time_ms > ? OR (m.time_ms = ? AND m.topic > ?) OR (m.time_ms = ? AND m.topic = ? AND m.msg_index > ?))';
            }
            params.push(lastTime, lastTime, lastTopic, lastTime, lastTopic, lastMsgIndex);
        }
        sql += order === 'desc'
            ? ' ORDER BY m.time_ms DESC, m.topic DESC, m.msg_index DESC LIMIT ?'
            : ' ORDER BY m.time_ms ASC, m.topic ASC, m.msg_index ASC LIMIT ?';
        params.push(chunkSize);
        const rows = db.prepare(sql).all(...params) as IndexedMessageRow[];
        if (rows.length === 0) break;
        for (const row of rows) {
            if (!rowMatchesIndexedSearch(row, conditions, terms, keywordLogic)) continue;
            const key = `${row.bucket_ts}|${row.topic}|${row.msg_index}`;
            if (seen?.has(key)) continue;
            seen?.add(key);
            if (skippedRef.value < offset) {
                skippedRef.value++;
                continue;
            }
            pushIndexedRow(db, bucketStmt, bucketCache, schemaVersion, fe, row, out);
            if (out.length >= limit) break;
        }
        const tail = rows[rows.length - 1];
        lastTime = tail.time_ms;
        lastTopic = tail.topic;
        lastMsgIndex = tail.msg_index;
        if (rows.length < chunkSize) break;
    }
    return true;
}

function queryFtsIndexedFile(
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
    seen: Set<string> | null,
    out: QueryOutput
): boolean {
    const match = buildFtsMatch(conditions, terms, keywordLogic);
    if (!match || getHistoryFtsTokenizer(db) !== 'trigram' || !hasFtsIndex(db) || shouldUseIndexedTextScan(db, conditions, terms)) return false;
    const chunkSize = 1000;
    const bucketStmt = db.prepare('SELECT blob FROM buckets WHERE bucket_ts = ? AND topic = ?');
    const bucketCache = new Map<string, HistoryMessage[]>();
    let lastTime: number | null = null;
    let lastTopic: string | null = null;
    let lastMsgIndex: number | null = null;
    while (out.length < limit) {
        let sql = `SELECT m.bucket_ts, m.time_ms, m.topic, m.msg_index, m.search_text, m.payload_offset, m.payload_len
                   FROM history_messages_fts
                   JOIN history_messages m
                     ON m.bucket_ts = history_messages_fts.bucket_ts AND m.topic = history_messages_fts.topic AND m.msg_index = history_messages_fts.msg_index
                   WHERE history_messages_fts MATCH ? AND m.time_ms BETWEEN ? AND ?`;
        const params: Array<number | string> = [match, st, et];
        if (topicFilter) {
            sql += ' AND m.topic = ?';
            params.push(topicFilter);
        }
        if (lastTime != null && lastTopic != null && lastMsgIndex != null) {
            if (order === 'desc') {
                sql += ' AND (m.time_ms < ? OR (m.time_ms = ? AND m.topic < ?) OR (m.time_ms = ? AND m.topic = ? AND m.msg_index < ?))';
            } else {
                sql += ' AND (m.time_ms > ? OR (m.time_ms = ? AND m.topic > ?) OR (m.time_ms = ? AND m.topic = ? AND m.msg_index > ?))';
            }
            params.push(lastTime, lastTime, lastTopic, lastTime, lastTopic, lastMsgIndex);
        }
        sql += order === 'desc'
            ? ' ORDER BY m.time_ms DESC, m.topic DESC, m.msg_index DESC LIMIT ?'
            : ' ORDER BY m.time_ms ASC, m.topic ASC, m.msg_index ASC LIMIT ?';
        params.push(chunkSize);
        const rows = db.prepare(sql).all(...params) as IndexedMessageRow[];
        if (rows.length === 0) break;
        for (const row of rows) {
            if (!rowMatchesIndexedSearch(row, conditions, terms, keywordLogic)) continue;
            const key = `${row.bucket_ts}|${row.topic}|${row.msg_index}`;
            if (seen?.has(key)) continue;
            seen?.add(key);
            if (skippedRef.value < offset) {
                skippedRef.value++;
                continue;
            }
            pushIndexedRow(db, bucketStmt, bucketCache, schemaVersion, fe, row, out);
            if (out.length >= limit) break;
        }
        const tail = rows[rows.length - 1];
        lastTime = tail.time_ms;
        lastTopic = tail.topic;
        lastMsgIndex = tail.msg_index;
        if (rows.length < chunkSize) break;
    }
    return true;
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
        const searchWhere = topicFilter && !matchesSearchText(normalizeKeyword(topicFilter), conditions, terms, keywordLogic)
            ? searchTextWhereForSearch(conditions, terms, keywordLogic)
            : null;
        let sql = 'SELECT bucket_ts, time_ms, topic, msg_index, search_text, payload_offset, payload_len FROM history_messages WHERE time_ms BETWEEN ? AND ?';
        const params: Array<number | string> = [st, et];
        if (topicFilter) {
            sql += ' AND topic = ?';
            params.push(topicFilter);
        }
        if (searchWhere) {
            sql += ` AND (${searchWhere.sql})`;
            params.push(...searchWhere.params);
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
        const rows = db.prepare(sql).all(...params) as IndexedMessageRow[];
        if (rows.length === 0) break;
        for (const row of rows) {
            if (!rowMatchesIndexedSearch(row, conditions, terms, keywordLogic)) continue;
            if (skippedRef.value < offset) {
                skippedRef.value++;
                continue;
            }
            pushIndexedRow(db, bucketStmt, bucketCache, schemaVersion, fe, row, out);
            if (out.length >= limit) break;
        }
        const tail = rows[rows.length - 1];
        lastTime = tail.time_ms;
        lastTopic = tail.topic;
        lastMsgIndex = tail.msg_index;
        if (rows.length < chunkSize) break;
    }
}

function shouldPreferTimeIndexedScan(st: number, et: number): boolean {
    return Number.isFinite(st) && Number.isFinite(et) && et >= st && et - st <= 24 * 60 * 60 * 1000;
}

function queryRecentTopicIndexedFile(
    db: Database.Database,
    schemaVersion: string,
    fe: { san: string },
    st: number,
    et: number,
    topicFilter: string,
    conditions: NormalizedCondition[],
    terms: string[],
    keywordLogic: 'and' | 'or',
    limit: number,
    out: QueryOutput
): void {
    const hasTextFilter = conditions.length > 0 || terms.length > 0;
    if (hasTextFilter) {
        const skippedRef = { value: 0 };
        queryIndexedFile(db, schemaVersion, fe, st, et, topicFilter, 'desc', conditions, terms, keywordLogic, limit, 0, skippedRef, out);
        return;
    }
    const candidateBatchSize = Math.max(1, limit);
    const bucketStmt = db.prepare('SELECT blob FROM buckets WHERE bucket_ts = ? AND topic = ?');
    const bucketCache = new Map<string, HistoryMessage[]>();
    let lastTime: number | null = null;
    let lastMsgIndex: number | null = null;
    let scanned = 0;

    while (out.length < limit) {
        let sql = 'SELECT bucket_ts, time_ms, topic, msg_index, search_text, payload_offset, payload_len FROM history_messages WHERE topic = ? AND time_ms BETWEEN ? AND ?';
        const params: Array<number | string> = [topicFilter, st, et];
        if (lastTime != null && lastMsgIndex != null) {
            sql += ' AND (time_ms < ? OR (time_ms = ? AND msg_index < ?))';
            params.push(lastTime, lastTime, lastMsgIndex);
        }
        sql += ' ORDER BY time_ms DESC, msg_index DESC LIMIT ?';
        params.push(candidateBatchSize);

        const rows = db.prepare(sql).all(...params) as IndexedMessageRow[];
        if (rows.length === 0) break;
        scanned += rows.length;
        for (const row of rows) {
            pushIndexedRow(db, bucketStmt, bucketCache, schemaVersion, fe, row, out);
            if (out.length >= limit) break;
        }
        const tail = rows[rows.length - 1];
        lastTime = tail.time_ms;
        lastMsgIndex = tail.msg_index;
        if (rows.length < candidateBatchSize) break;
    }
}

function canUseRecentTopicFastPath(topicFilter: string | null, order: 'asc' | 'desc', offset: number): topicFilter is string {
    return Boolean(topicFilter) && order === 'desc' && offset === 0;
}

function queryRawTopicBuckets(
    db: Database.Database,
    fe: { san: string },
    st: number,
    et: number,
    topicFilter: string,
    conditions: NormalizedCondition[],
    terms: string[],
    keywordLogic: 'and' | 'or',
    limit: number,
    out: QueryOutput
): void {
    const bucketStart = Math.floor(st / 1000);
    const bucketEnd = Math.floor(et / 1000);
    const rows = db.prepare(
        `SELECT bucket_ts, topic, blob FROM buckets
         WHERE topic = ? AND bucket_ts BETWEEN ? AND ?
         ORDER BY bucket_ts DESC`
    ).all(topicFilter, bucketStart, bucketEnd) as { bucket_ts: number; topic: string; blob: Buffer }[];
    for (const row of rows) {
        const entries = decodeBucket(row.blob, row.bucket_ts, row.topic)
            .filter((item) => item.time >= st && item.time <= et)
            .sort((a, b) => b.time - a.time);
        for (const item of entries) {
            if (!matchesSearchText(normalizeCombinedSearchText(item.topic, item.payload), conditions, terms, keywordLogic)) continue;
            out.push({ connectionId: fe.san, topic: item.topic, payload: item.payload, time: item.time });
            if (out.length >= limit) return;
        }
    }
}

function queryRawRecentTopicFiles(
    st: number,
    et: number,
    topicFilter: string,
    conditions: NormalizedCondition[],
    terms: string[],
    keywordLogic: 'and' | 'or',
    limit: number,
    out: QueryOutput
): void {
    const files = collectDayFiles(logRoot, { connectionId: opts.connectionId, startTime: st, endTime: et, order: 'desc' });
    for (const fe of files) {
        if (out.length >= limit) break;
        const db = new Database(fe.path, { readonly: true });
        try {
            queryRawTopicBuckets(db, fe, st, et, topicFilter, conditions, terms, keywordLogic, limit, out);
        } finally {
            db.close();
        }
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

    if (canUseRecentTopicFastPath(topicFilter, order, offset)) {
        for (const fe of files) {
            if (out.length >= limit) break;
            const db = new Database(fe.path, { readonly: true });
            try {
                const indexSchemaVersion = getBestEffortIndexVersion(db);
                if (!indexSchemaVersion) continue;
                queryRecentTopicIndexedFile(db, indexSchemaVersion, fe, st, et, topicFilter, conditions, terms, keywordLogic, limit, out);
            } finally {
                db.close();
            }
        }
        if (out.length === 0 && (conditions.length > 0 || terms.length > 0)) {
            const topicOnlyConditions = conditions.filter((item) => item.join !== 'and' || !topicFilter.includes(item.term));
            queryRawRecentTopicFiles(st, et, topicFilter, topicOnlyConditions, terms, keywordLogic, limit, out);
        }
        return;
    }

    const skippedRef = { value: 0 };

    for (const fe of files) {
        if (out.length >= limit) break;
        const db = new Database(fe.path, { readonly: true });
        try {
            const indexSchemaVersion = getBestEffortIndexVersion(db);
            if (!indexSchemaVersion) continue;
            if (conditions.length > 0 || terms.length > 0) {
                if (shouldPreferTimeIndexedScan(st, et) || topicFilter) {
                    queryIndexedFile(db, indexSchemaVersion, fe, st, et, topicFilter, order, conditions, terms, keywordLogic, limit, offset, skippedRef, out);
                } else {
                    const usedFts = queryFtsIndexedFile(db, indexSchemaVersion, fe, st, et, null, order, conditions, terms, keywordLogic, limit, offset, skippedRef, null, out);
                    if (!usedFts) queryIndexedFile(db, indexSchemaVersion, fe, st, et, null, order, conditions, terms, keywordLogic, limit, offset, skippedRef, out);
                }
            } else {
                queryIndexedFile(db, indexSchemaVersion, fe, st, et, topicFilter, order, conditions, terms, keywordLogic, limit, offset, skippedRef, out);
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
