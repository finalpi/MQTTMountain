import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import type { HistoryMessage, HistoryQueryOptions } from '../../shared/types';
import { decodeBucket, readPayloadBytesSlice } from './history-bucket-codec';
import {
    collectDayFiles,
    historyFileTimeRangeFromKey,
    matchesSearchText,
    normalizeCombinedSearchText,
    normalizeConditions,
    normalizeKeyword,
    parseKeywordTerms,
    type DayFileEntry,
    type NormalizedCondition
} from './history-query-common';
import { getHistoryFtsLayout, getHistoryFtsTokenizer, getHistoryIndexSchemaVersion, getIndexMeta, isHistoryFtsComplete } from './history-index-schema';
import { decodePayloadView } from './payload-codec';

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
    search_text?: string;
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
const MAX_DECODED_BUCKET_CACHE = 256;
const queryStartedAt = Date.now();
let queryFilesRead = 0;
let queryPeakCandidateRows = 0;

function getDecodedBucket(
    cache: Map<string, HistoryMessage[]>,
    key: string,
    blob: Buffer,
    bucketTs: number,
    topic: string
): HistoryMessage[] {
    const cached = cache.get(key);
    if (cached) return cached;
    const decoded = decodeBucket(blob, bucketTs, topic);
    if (cache.size >= MAX_DECODED_BUCKET_CACHE) {
        const oldest = cache.keys().next().value as string | undefined;
        if (oldest != null) cache.delete(oldest);
    }
    cache.set(key, decoded);
    return decoded;
}

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
    return getHistoryFtsTokenizer(db) !== 'none' && isHistoryFtsComplete(db) && tableExists(db, 'history_messages_fts');
}

function ftsJoinSql(db: Database.Database): string {
    return getHistoryFtsLayout(db) === 'contentless'
        ? 'FROM history_messages_fts JOIN history_messages m ON m.id = history_messages_fts.rowid'
        : `FROM history_messages_fts
           JOIN history_messages m
             ON m.bucket_ts = history_messages_fts.bucket_ts AND m.topic = history_messages_fts.topic AND m.msg_index = history_messages_fts.msg_index`;
}

function sendDiagnostic(label: string, data: Record<string, unknown>): void {
    parentPort?.postMessage({ type: 'diagnostic', label, data });
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

function compactTrigramTerm(term: string): string | null {
    const chars = Array.from(term);
    if (chars.length < 3) return null;
    const trigrams = [...new Set(chars.slice(0, -2).map((_, index) => chars.slice(index, index + 3).join('')))];
    return `(${trigrams.map((value) => `"${value.replace(/"/g, '""')}"`).join(' AND ')})`;
}

function buildCompactFtsMatch(conditions: NormalizedCondition[], terms: string[], keywordLogic: 'and' | 'or'): string | null {
    if (conditions.some((item) => item.join === 'not')) return null;
    const values = conditions.length > 0 ? conditions.map((item) => item.term) : terms;
    const groups = values.map(compactTrigramTerm);
    if (groups.length === 0 || groups.some((value) => !value)) return null;
    if (conditions.length > 0) {
        return groups.map((group, index) => index === 0 ? group : `${conditions[index].join === 'or' ? 'OR' : 'AND'} ${group}`).join(' ');
    }
    return groups.join(keywordLogic === 'or' ? ' OR ' : ' AND ');
}

function buildFtsMatchForSchema(schemaVersion: string, conditions: NormalizedCondition[], terms: string[], keywordLogic: 'and' | 'or'): string | null {
    return schemaVersion === '6'
        ? buildCompactFtsMatch(conditions, terms, keywordLogic)
        : buildFtsMatch(conditions, terms, keywordLogic);
}

function indexedSelectColumns(schemaVersion: string, alias = ''): string {
    const p = alias ? `${alias}.` : '';
    const search = schemaVersion === '5' ? `${p}search_text` : 'NULL AS search_text';
    return `${p}bucket_ts, ${p}time_ms, ${p}topic, ${p}msg_index, ${search}, ${p}payload_offset, ${p}payload_len`;
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
    const message = readIndexedMessage(db, bucketStmt, bucketCache, fe, row);
    if (message) out.push(message);
}

function readIndexedMessage(
    db: Database.Database,
    bucketStmt: Database.Statement,
    bucketCache: Map<string, HistoryMessage[]>,
    fe: { san: string },
    row: IndexedMessageRow
): HistoryMessage | null {
    void db;
    const bucket = bucketStmt.get(row.bucket_ts, row.topic) as { blob: Buffer } | undefined;
    if (!bucket) return null;
    const payloadBytes = readPayloadBytesSlice(bucket.blob, row.payload_offset ?? -1, row.payload_len ?? -1);
    if (payloadBytes) {
        const payload = decodePayloadView(payloadBytes);
        return {
            connectionId: fe.san,
            topic: row.topic,
            payload: payload.text,
            time: row.time_ms,
            payloadSize: payload.size,
            payloadEncoding: payload.encoding,
            ...(payload.encoding === 'utf8' ? {} : { payloadBase64: payloadBytes.toString('base64') })
        };
    }
    {
        const cacheKey = `${row.bucket_ts}|${row.topic}`;
        const decoded = getDecodedBucket(bucketCache, cacheKey, bucket.blob, row.bucket_ts, row.topic);
        const message = decoded[row.msg_index];
        if (!message) return null;
        return { ...message, connectionId: fe.san, topic: row.topic, time: row.time_ms };
    }
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
    out: QueryOutput,
    emit = true
): boolean {
    const message = readIndexedMessage(db, bucketStmt, bucketCache, fe, row);
    if (!message) return false;
    if (!matchesSearchText(normalizeCombinedSearchText(row.topic, message.payload), conditions, terms, keywordLogic)) return false;
    if (emit) out.push(message);
    return true;
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
    if (row.search_text == null) return true;
    return matchesSearchText(normalizeCombinedSearchText(row.topic, row.search_text), conditions, terms, keywordLogic);
}

function queryTopicTextIndexedFile(
    db: Database.Database,
    schemaVersion: string,
    fe: { san: string },
    st: number,
    et: number,
    topicFilter: string | null,
    order: 'asc' | 'desc',
    candidateTerms: string[],
    conditions: NormalizedCondition[],
    terms: string[],
    keywordLogic: 'and' | 'or',
    limit: number,
    offset: number,
    skippedRef: { value: number },
    seen: Set<string>,
    out: QueryOutput
): void {
    const where = buildLikeWhere('lower(topic)', [], candidateTerms, 'or');
    if (!where) return;
    const chunkSize = 1000;
    const bucketStmt = db.prepare('SELECT blob FROM buckets WHERE bucket_ts = ? AND topic = ?');
    const bucketCache = new Map<string, HistoryMessage[]>();
    let lastTime: number | null = null;
    let lastTopic: string | null = null;
    let lastMsgIndex: number | null = null;
    while (out.length < limit) {
        let sql = `SELECT ${indexedSelectColumns(schemaVersion)}
                   FROM history_messages
                   WHERE time_ms BETWEEN ? AND ? AND (${where.sql})`;
        const params: Array<number | string> = [st, et, ...where.params];
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
        const rows = db.prepare(sql).all(...params) as IndexedMessageRow[];
        if (rows.length === 0) break;
        for (const row of rows) {
            if (!pushIndexedRowIfMatches(db, bucketStmt, bucketCache, schemaVersion, fe, row, conditions, terms, keywordLogic, out, false)) continue;
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
    candidateTerms: string[],
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
    const match = buildCompactFtsMatch([], candidateTerms, 'or');
    if (!match) return false;
    if (candidateTerms.some((term) => Array.from(term).length < 3)) return false;
    const chunkSize = 1000;
    const bucketStmt = db.prepare('SELECT blob FROM buckets WHERE bucket_ts = ? AND topic = ?');
    const bucketCache = new Map<string, HistoryMessage[]>();
    let lastTime: number | null = null;
    let lastTopic: string | null = null;
    let lastMsgIndex: number | null = null;
    while (out.length < limit) {
        let sql = `SELECT ${indexedSelectColumns(schemaVersion, 'm')}
                   ${ftsJoinSql(db)}
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
            if (schemaVersion === '6'
                ? !pushIndexedRowIfMatches(db, bucketStmt, bucketCache, schemaVersion, fe, row, conditions, terms, keywordLogic, out, false)
                : !rowMatchesIndexedSearch(row, conditions, terms, keywordLogic)) continue;
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

function getCandidateTerms(conditions: NormalizedCondition[], terms: string[]): string[] {
    const values = conditions.length > 0
        ? conditions.filter((item, index) => index === 0 || item.join !== 'not').map((item) => item.term)
        : terms;
    return [...new Set(values)];
}

function queryCombinedTextIndexedFile(
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
    out: QueryOutput
): boolean {
    const candidateTerms = getCandidateTerms(conditions, terms);
    if (schemaVersion !== '6'
        || candidateTerms.length === 0
        || candidateTerms.some((term) => Array.from(term).length < 3)
        || !hasFtsIndex(db)) return false;

    const seen = new Set<string>();
    const payloadOut = new ArrayQueryOutput();
    const topicOut = new ArrayQueryOutput();
    const usedPayloadFts = queryTrigramFtsIndexedFile(
        db, schemaVersion, fe, st, et, topicFilter, order, candidateTerms,
        conditions, terms, keywordLogic, limit, 0, { value: 0 }, seen, payloadOut
    );
    if (!usedPayloadFts) return false;
    queryTopicTextIndexedFile(
        db, schemaVersion, fe, st, et, topicFilter, order, candidateTerms,
        conditions, terms, keywordLogic, limit, 0, { value: 0 }, seen, topicOut
    );

    const rows = mergeSortedHistoryRows(payloadOut.rows, topicOut.rows, limit, order);
    for (const row of rows) out.push(row);
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
    const match = buildFtsMatchForSchema(schemaVersion, conditions, terms, keywordLogic);
    if (!match || getHistoryFtsTokenizer(db) !== 'trigram' || !hasFtsIndex(db) || shouldUseIndexedTextScan(db, conditions, terms)) return false;
    const chunkSize = 1000;
    const bucketStmt = db.prepare('SELECT blob FROM buckets WHERE bucket_ts = ? AND topic = ?');
    const bucketCache = new Map<string, HistoryMessage[]>();
    let lastTime: number | null = null;
    let lastTopic: string | null = null;
    let lastMsgIndex: number | null = null;
    while (out.length < limit) {
        let sql = `SELECT ${indexedSelectColumns(schemaVersion, 'm')}
                   ${ftsJoinSql(db)}
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
            if (schemaVersion === '6'
                ? !pushIndexedRowIfMatches(db, bucketStmt, bucketCache, schemaVersion, fe, row, conditions, terms, keywordLogic, out, false)
                : !rowMatchesIndexedSearch(row, conditions, terms, keywordLogic)) continue;
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
        const searchWhere = schemaVersion === '5' && topicFilter && !matchesSearchText(normalizeKeyword(topicFilter), conditions, terms, keywordLogic)
            ? searchTextWhereForSearch(conditions, terms, keywordLogic)
            : null;
        let sql = `SELECT ${indexedSelectColumns(schemaVersion)} FROM history_messages WHERE time_ms BETWEEN ? AND ?`;
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
            if (schemaVersion === '6'
                ? !pushIndexedRowIfMatches(db, bucketStmt, bucketCache, schemaVersion, fe, row, conditions, terms, keywordLogic, out, false)
                : !rowMatchesIndexedSearch(row, conditions, terms, keywordLogic)) continue;
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
        if (schemaVersion === '6') {
            const usedFts = queryFtsIndexedFile(
                db, schemaVersion, fe, st, et, topicFilter, 'desc', conditions, terms, keywordLogic,
                limit, 0, skippedRef, null, out
            );
            if (usedFts) return;
        }
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
        let sql = `SELECT ${indexedSelectColumns(schemaVersion)} FROM history_messages WHERE topic = ? AND time_ms BETWEEN ? AND ?`;
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

function compareHistoryRows(a: HistoryMessage, b: HistoryMessage, order: 'asc' | 'desc'): number {
    const direction = order === 'asc' ? 1 : -1;
    if (a.time !== b.time) return (a.time - b.time) * direction;
    const connectionCompare = a.connectionId.localeCompare(b.connectionId);
    if (connectionCompare !== 0) return connectionCompare * direction;
    const topicCompare = a.topic.localeCompare(b.topic);
    return topicCompare * direction;
}

function mergeSortedHistoryRows(
    left: HistoryMessage[],
    right: HistoryMessage[],
    limit: number,
    order: 'asc' | 'desc'
): HistoryMessage[] {
    const merged: HistoryMessage[] = [];
    let leftIndex = 0;
    let rightIndex = 0;
    while (merged.length < limit && (leftIndex < left.length || rightIndex < right.length)) {
        if (leftIndex >= left.length) merged.push(right[rightIndex++]);
        else if (rightIndex >= right.length) merged.push(left[leftIndex++]);
        else if (compareHistoryRows(left[leftIndex], right[rightIndex], order) <= 0) merged.push(left[leftIndex++]);
        else merged.push(right[rightIndex++]);
    }
    return merged;
}

function groupFilesByOverlappingRange(files: DayFileEntry[], order: 'asc' | 'desc'): DayFileEntry[][] {
    const ranged = files.map((file) => ({ file, range: historyFileTimeRangeFromKey(file.dk) }))
        .filter((item): item is { file: DayFileEntry; range: { start: number; end: number } } => Boolean(item.range))
        .sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end || a.file.san.localeCompare(b.file.san));
    const groups: Array<{ start: number; end: number; files: DayFileEntry[] }> = [];
    for (const item of ranged) {
        const current = groups[groups.length - 1];
        if (current && item.range.start <= current.end) {
            current.end = Math.max(current.end, item.range.end);
            current.files.push(item.file);
        } else {
            groups.push({ start: item.range.start, end: item.range.end, files: [item.file] });
        }
    }
    const ordered = order === 'asc' ? groups : groups.reverse();
    return ordered.map((group) => group.files);
}

function queryRawFile(
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
    out: QueryOutput
): void {
    if (!tableExists(db, 'buckets')) return;
    const bucketStart = Math.floor(st / 1000);
    const bucketEnd = Math.floor(et / 1000);
    let sql = 'SELECT bucket_ts, topic, blob FROM buckets WHERE bucket_ts BETWEEN ? AND ?';
    const params: Array<number | string> = [bucketStart, bucketEnd];
    if (topicFilter) {
        sql += ' AND topic = ?';
        params.push(topicFilter);
    }
    sql += order === 'asc'
        ? ' ORDER BY bucket_ts ASC, topic ASC'
        : ' ORDER BY bucket_ts DESC, topic DESC';

    let activeBucketTs: number | null = null;
    let bucketRows: HistoryMessage[] = [];
    const flushBucket = (): boolean => {
        bucketRows.sort((a, b) => compareHistoryRows(a, b, order));
        for (const message of bucketRows) {
            out.push(message);
            if (out.length >= limit) return true;
        }
        bucketRows = [];
        return false;
    };

    for (const row of db.prepare(sql).iterate(...params) as Iterable<{ bucket_ts: number; topic: string; blob: Buffer }>) {
        if (activeBucketTs != null && row.bucket_ts !== activeBucketTs && flushBucket()) return;
        activeBucketTs = row.bucket_ts;
        for (const item of decodeBucket(row.blob, row.bucket_ts, row.topic)) {
            if (item.time < st || item.time > et) continue;
            if (!matchesSearchText(normalizeCombinedSearchText(item.topic, item.payload), conditions, terms, keywordLogic)) continue;
            bucketRows.push({ ...item, connectionId: fe.san, topic: row.topic });
        }
    }
    flushBucket();
}

function queryHistoryFile(
    fe: DayFileEntry,
    st: number,
    et: number,
    topicFilter: string | null,
    order: 'asc' | 'desc',
    conditions: NormalizedCondition[],
    terms: string[],
    keywordLogic: 'and' | 'or',
    limit: number,
    out: QueryOutput
): void {
    queryFilesRead++;
    const db = new Database(fe.path, { readonly: true });
    try {
        const indexSchemaVersion = getUsableIndexVersion(db);
        if (!indexSchemaVersion) {
            sendDiagnostic('[history-query] raw bucket fallback', {
                filePath: fe.path,
                reason: getBestEffortIndexVersion(db) ? 'index-incomplete' : 'index-missing'
            });
            queryRawFile(db, fe, st, et, topicFilter, order, conditions, terms, keywordLogic, limit, out);
            return;
        }

        const hasTextFilter = conditions.length > 0 || terms.length > 0;
        if (!hasTextFilter && canUseRecentTopicFastPath(topicFilter, order, 0)) {
            queryRecentTopicIndexedFile(db, indexSchemaVersion, fe, st, et, topicFilter, conditions, terms, keywordLogic, limit, out);
            return;
        }

        const skippedRef = { value: 0 };
        if (hasTextFilter && !shouldPreferTimeIndexedScan(st, et)) {
            const usedCombinedIndex = queryCombinedTextIndexedFile(
                db, indexSchemaVersion, fe, st, et, topicFilter, order,
                conditions, terms, keywordLogic, limit, out
            );
            if (usedCombinedIndex) return;
        }
        queryIndexedFile(
            db, indexSchemaVersion, fe, st, et, topicFilter, order,
            conditions, terms, keywordLogic, limit, 0, skippedRef, out
        );
    } finally {
        db.close();
    }
}

function queryHistory(out: QueryOutput): void {
    const st = opts.startTime != null && opts.startTime > 0 ? opts.startTime : -8640000000000000;
    const et = opts.endTime != null && opts.endTime > 0 ? opts.endTime : 8640000000000000;
    const limit = Math.min(500_000, Math.max(1, Math.floor(opts.limit ?? 500)));
    let remainingOffset = Math.max(0, Math.floor(opts.offset ?? 0));
    const order = opts.order === 'asc' ? 'asc' : 'desc';
    const conditions = normalizeConditions(opts.conditions);
    const terms = conditions.length ? [] : parseKeywordTerms(opts.keywords?.length ? opts.keywords : (opts.keyword ? [opts.keyword] : []));
    const keywordLogic = opts.keywordLogic === 'or' ? 'or' : 'and';
    const topicFilter = opts.topic && opts.topic.trim() ? opts.topic.trim() : null;

    const files = collectDayFiles(logRoot, { connectionId: opts.connectionId, startTime: st, endTime: et, order });
    for (const group of groupFilesByOverlappingRange(files, order)) {
        if (out.length >= limit) break;
        const remainingLimit = limit - out.length;
        const candidateLimit = Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, remainingOffset + remainingLimit));
        let candidates: HistoryMessage[] = [];
        for (const fe of group) {
            const fileOut = new ArrayQueryOutput();
            queryHistoryFile(fe, st, et, topicFilter, order, conditions, terms, keywordLogic, candidateLimit, fileOut);
            const merged = mergeSortedHistoryRows(candidates, fileOut.rows, candidateLimit, order);
            queryPeakCandidateRows = Math.max(queryPeakCandidateRows, candidates.length + fileOut.rows.length + merged.length);
            candidates = merged;
        }
        const start = Math.min(remainingOffset, candidates.length);
        remainingOffset -= start;
        for (let i = start; i < candidates.length && out.length < limit; i++) out.push(candidates[i]);
    }
}

try {
    if (stream) {
        if (!requestId) throw new Error('缺少流式查询 requestId');
        const streamOut = new StreamQueryOutput(requestId, Math.min(5000, Math.max(100, chunkSize ?? 1000)));
        queryHistory(streamOut);
        streamOut.flush();
        sendDiagnostic('[history-query] completed', {
            elapsedMs: Date.now() - queryStartedAt,
            filesRead: queryFilesRead,
            peakCandidateRows: queryPeakCandidateRows,
            resultRows: streamOut.length,
            stream: true
        });
        parentPort?.postMessage({ type: 'done', requestId, total: streamOut.length, truncated: streamOut.length >= Math.min(500_000, Math.max(1, opts.limit ?? 500)) });
    } else {
        const arrayOut = new ArrayQueryOutput();
        queryHistory(arrayOut);
        sendDiagnostic('[history-query] completed', {
            elapsedMs: Date.now() - queryStartedAt,
            filesRead: queryFilesRead,
            peakCandidateRows: queryPeakCandidateRows,
            resultRows: arrayOut.rows.length,
            stream: false
        });
        parentPort?.postMessage({ type: 'done', data: arrayOut.rows });
    }
} catch (error) {
    parentPort?.postMessage({ type: 'error', requestId, error: (error as Error).message || '查询失败' });
}
