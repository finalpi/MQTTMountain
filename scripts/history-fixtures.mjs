import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const { app } = require('electron');
const Database = require('better-sqlite3');

const DAY = '2026-06-25';
const CONNECTION_ID = 'fixture-connection';
const SAN_CONNECTION_ID = sanitizeConnectionId(CONNECTION_ID);
const V5_SCHEMA_VERSION = '5';
const V4_SCHEMA_VERSION = '4';
const V3_SCHEMA_VERSION = '3';
const V2_SCHEMA_VERSION = '2';

const MESSAGES = [
  { topic: 'sensor/temp', payload: 'alpha room 21', time: new Date(2026, 5, 25, 9, 0, 0, 120).getTime() },
  { topic: 'sensor/temp', payload: 'beta room 22', time: new Date(2026, 5, 25, 9, 0, 0, 450).getTime() },
  { topic: 'sensor/humidity', payload: 'alpha humidity 45', time: new Date(2026, 5, 25, 9, 0, 1, 50).getTime() },
  { topic: 'device/status', payload: 'online ok', time: new Date(2026, 5, 25, 9, 0, 1, 500).getTime() },
  { topic: 'sensor/temp', payload: 'gamma room 23', time: new Date(2026, 5, 25, 9, 0, 2, 30).getTime() },
  { topic: 'thing/product/hezhou', payload: 'payload does not repeat topic words', time: new Date(2026, 5, 25, 9, 0, 3, 10).getTime() }
];

const QUERY_CASES = [
  { name: 'desc limit', opts: { connectionId: CONNECTION_ID, order: 'desc', limit: 3 } },
  { name: 'asc offset', opts: { connectionId: CONNECTION_ID, order: 'asc', limit: 2, offset: 1 } },
  { name: 'topic filter', opts: { connectionId: CONNECTION_ID, order: 'asc', limit: 10, topic: 'sensor/temp' } },
  { name: 'topic keyword recent startTime', opts: { connectionId: CONNECTION_ID, order: 'asc', limit: 10, topic: 'sensor/temp', keyword: 'room', startTime: MESSAGES[1].time } },
  { name: 'topic keyword bounded endTime', opts: { connectionId: CONNECTION_ID, order: 'desc', limit: 10, topic: 'sensor/temp', keyword: 'room', endTime: MESSAGES[1].time } },
  { name: 'topic no keyword recent startTime', opts: { connectionId: CONNECTION_ID, order: 'asc', limit: 10, topic: 'sensor/temp', startTime: MESSAGES[1].time } },
  { name: 'topic keyword all time', opts: { connectionId: CONNECTION_ID, order: 'asc', limit: 10, topic: 'sensor/temp', keyword: 'room' } },
  { name: 'topic-only keyword bounded', opts: { connectionId: CONNECTION_ID, order: 'desc', limit: 10, keyword: 'thing/product', startTime: MESSAGES[5].time - 60_000, endTime: MESSAGES[5].time + 60_000 } },
  { name: 'topic-only short keyword bounded', opts: { connectionId: CONNECTION_ID, order: 'desc', limit: 10, keyword: 'thing', startTime: MESSAGES[5].time - 60_000, endTime: MESSAGES[5].time + 60_000 } },
  { name: 'keyword and', opts: { connectionId: CONNECTION_ID, order: 'asc', limit: 10, keyword: 'alpha' } },
  { name: 'keyword or', opts: { connectionId: CONNECTION_ID, order: 'asc', limit: 10, keywords: ['humidity', 'online'], keywordLogic: 'or' } },
  { name: 'conditions not', opts: { connectionId: CONNECTION_ID, order: 'asc', limit: 10, conditions: [{ join: 'and', term: 'sensor' }, { join: 'not', term: 'gamma' }] } }
];

function sanitizeConnectionId(id) {
  if (!id) return '_none';
  const s = String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
  return s.length > 120 ? s.slice(0, 120) : s || '_empty';
}

function normalizeKeyword(value) {
  return String(value || '').replace(/\s+/gu, '').toLowerCase();
}

function normalizePayloadSearchText(payload) {
  return normalizeKeyword(payload);
}

function normalizeCombinedSearchText(topic, payload) {
  return `${normalizeKeyword(topic)}${normalizeKeyword(payload)}`;
}

function normalizeSearchText(topic, payload) {
  void topic;
  return normalizePayloadSearchText(payload);
}

function encodeBucket(items, bucketSec) {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(items.length, 0);
  const base = bucketSec * 1000;
  const parts = [head];
  for (const item of items) {
    const payload = Buffer.from(item.payload, 'utf8');
    const meta = Buffer.alloc(6);
    meta.writeUInt16LE(Math.max(0, Math.min(65535, item.time - base)), 0);
    meta.writeUInt32LE(payload.length, 2);
    parts.push(meta, payload);
  }
  return Buffer.concat(parts);
}

function iterateBucketEntries(blob, bucketSec) {
  const out = [];
  if (!Buffer.isBuffer(blob) || blob.length < 4) return out;
  const base = bucketSec * 1000;
  const count = blob.readUInt32LE(0);
  let p = 4;
  for (let i = 0; i < count && p + 6 <= blob.length; i++) {
    const entryOffset = p;
    const off = blob.readUInt16LE(p);
    p += 2;
    const payloadLen = blob.readUInt32LE(p);
    p += 4;
    const payloadOffset = p;
    if (payloadOffset + payloadLen > blob.length) break;
    const payload = blob.subarray(payloadOffset, payloadOffset + payloadLen).toString('utf8');
    p += payloadLen;
    out.push({ msgIndex: i, time: base + off, payload, entryOffset, payloadOffset, payloadLen, entryLen: p - entryOffset });
  }
  return out;
}

function readPayloadSlice(blob, payloadOffset, payloadLen) {
  if (!Buffer.isBuffer(blob)) return null;
  if (!Number.isSafeInteger(payloadOffset) || !Number.isSafeInteger(payloadLen)) return null;
  if (payloadOffset < 4 || payloadLen < 0 || payloadOffset + payloadLen > blob.length) return null;
  return blob.subarray(payloadOffset, payloadOffset + payloadLen).toString('utf8');
}

function decodeBucket(blob, bucketSec, topic) {
  return iterateBucketEntries(blob, bucketSec).map((entry) => ({ connectionId: '', topic, payload: entry.payload, time: entry.time }));
}

function validateBucketBlob(blob, expectedCount, expectedBytes) {
  if (!Buffer.isBuffer(blob) || blob.length < 4) return { valid: false, structureValid: false };
  const count = blob.readUInt32LE(0);
  let p = 4;
  for (let i = 0; i < count; i++) {
    if (p + 6 > blob.length) return { valid: false, structureValid: false };
    p += 2;
    const len = blob.readUInt32LE(p);
    p += 4;
    if (p + len > blob.length) return { valid: false, structureValid: false };
    p += len;
  }
  if (p !== blob.length) return { valid: false, structureValid: false };
  return { valid: count === expectedCount && blob.length === expectedBytes, structureValid: true, count };
}

function ensureSchema(db) {
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
}

function ensureIndexSchema(db, schemaVersion) {
  const hasOffsetColumns = schemaVersion === V3_SCHEMA_VERSION || schemaVersion === V4_SCHEMA_VERSION || schemaVersion === V5_SCHEMA_VERSION;
  const hasFts = schemaVersion === V4_SCHEMA_VERSION || schemaVersion === V5_SCHEMA_VERSION;
  const offsetColumns = hasOffsetColumns
    ? `,
      payload_offset INTEGER NOT NULL,
      payload_len INTEGER NOT NULL,
      entry_offset INTEGER NOT NULL,
      entry_len INTEGER NOT NULL`
    : '';
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_messages (
      bucket_ts INTEGER NOT NULL,
      topic TEXT NOT NULL,
      msg_index INTEGER NOT NULL,
      time_ms INTEGER NOT NULL,
      search_text TEXT NOT NULL${offsetColumns},
      PRIMARY KEY (bucket_ts, topic, msg_index)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_history_messages_time_topic_msg ON history_messages(time_ms, topic, msg_index);
    CREATE INDEX IF NOT EXISTS idx_history_messages_topic_time_msg ON history_messages(topic, time_ms, msg_index);
    CREATE TABLE IF NOT EXISTS history_index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID;
  `);
  if (hasFts) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS history_messages_fts USING fts5(
        search_text,
        bucket_ts UNINDEXED,
        topic UNINDEXED,
        msg_index UNINDEXED,
        time_ms UNINDEXED,
        tokenize='unicode61'
      );
    `);
  }
}

function setMeta(db, key, value) {
  db.prepare('INSERT INTO history_index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM history_index_meta WHERE key = ?').get(key);
  return row?.value ?? null;
}

function buildFixtureDb(filePath, options = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  try {
    ensureSchema(db);
    const groups = new Map();
    for (const msg of MESSAGES) {
      const sec = Math.floor(msg.time / 1000);
      const key = `${sec}\0${msg.topic}`;
      let group = groups.get(key);
      if (!group) {
        group = { sec, topic: msg.topic, items: [] };
        groups.set(key, group);
      }
      group.items.push(msg);
    }
    const insertBucket = db.prepare('INSERT INTO buckets (bucket_ts, topic, blob, count, bytes) VALUES (?, ?, ?, ?, ?)');
    for (const group of groups.values()) {
      const blob = encodeBucket(group.items, group.sec);
      const count = options.metadataMismatch && group.topic === 'sensor/temp' && group.sec === Math.floor(MESSAGES[0].time / 1000)
        ? group.items.length + 1
        : group.items.length;
      insertBucket.run(group.sec, group.topic, blob, count, blob.length);
    }

    if (options.index !== 'none') {
      const schemaVersion = options.schemaVersion || V2_SCHEMA_VERSION;
      const hasOffsetColumns = schemaVersion === V3_SCHEMA_VERSION || schemaVersion === V4_SCHEMA_VERSION || schemaVersion === V5_SCHEMA_VERSION;
      const hasFts = schemaVersion === V4_SCHEMA_VERSION || schemaVersion === V5_SCHEMA_VERSION;
      ensureIndexSchema(db, schemaVersion);
      setMeta(db, 'schema_version', schemaVersion);
      setMeta(db, 'fts5_enabled', hasFts ? '1' : '0');
      setMeta(db, 'fts5_tokenizer', hasFts ? 'unicode61' : 'none');
      setMeta(db, 'index_complete', options.index === 'complete' ? '1' : '0');
      setMeta(db, 'index_dirty_at', options.index === 'complete' ? '0' : Date.now());
      const insertIndex = hasOffsetColumns
        ? db.prepare('INSERT INTO history_messages (bucket_ts, topic, msg_index, time_ms, search_text, payload_offset, payload_len, entry_offset, entry_len) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        : db.prepare('INSERT INTO history_messages (bucket_ts, topic, msg_index, time_ms, search_text) VALUES (?, ?, ?, ?, ?)');
      const insertFts = hasFts
        ? db.prepare('INSERT INTO history_messages_fts (search_text, bucket_ts, topic, msg_index, time_ms) VALUES (?, ?, ?, ?, ?)')
        : null;
      let indexedBuckets = 0;
      let indexedMessages = 0;
      for (const group of groups.values()) {
        if (options.index === 'incomplete' && group.topic === 'device/status') continue;
        const blobRow = db.prepare('SELECT blob FROM buckets WHERE bucket_ts = ? AND topic = ?').get(group.sec, group.topic);
        const entries = iterateBucketEntries(blobRow.blob, group.sec);
        for (const entry of entries) {
          const searchText = normalizeSearchText(group.topic, entry.payload);
          if (hasOffsetColumns) {
            insertIndex.run(group.sec, group.topic, entry.msgIndex, entry.time, searchText, entry.payloadOffset, entry.payloadLen, entry.entryOffset, entry.entryLen);
          } else {
            insertIndex.run(group.sec, group.topic, entry.msgIndex, entry.time, searchText);
          }
          insertFts?.run(searchText, group.sec, group.topic, entry.msgIndex, entry.time);
          indexedMessages++;
        }
        indexedBuckets++;
      }
      setMeta(db, 'indexed_bucket_count', indexedBuckets);
      setMeta(db, 'indexed_message_count', indexedMessages);
      setMeta(db, 'last_indexed_at', Date.now());
    }
  } finally {
    db.close();
  }
}

function parseKeywordTerms(input) {
  const items = Array.isArray(input) ? input : [input];
  return [...new Set(items.map(normalizeKeyword).filter(Boolean))];
}

function normalizeConditions(conditions = []) {
  return conditions.map((item) => ({ join: item.join, term: normalizeKeyword(item.term) })).filter((item) => item.term);
}

function matchesSearchText(hay, conditions, terms, logic) {
  if (conditions.length === 0 && terms.length === 0) return true;
  if (conditions.length) {
    let result = hay.includes(conditions[0].term);
    for (let i = 1; i < conditions.length; i++) {
      const hit = hay.includes(conditions[i].term);
      if (conditions[i].join === 'or') result = result || hit;
      else if (conditions[i].join === 'not') result = result && !hit;
      else result = result && hit;
    }
    return result;
  }
  return logic === 'or' ? terms.some((term) => hay.includes(term)) : terms.every((term) => hay.includes(term));
}

function getUsableIndexVersion(db) {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'history_messages'").get();
    const version = getMeta(db, 'schema_version');
    if (!row || getMeta(db, 'index_complete') !== '1') return null;
    return version === V5_SCHEMA_VERSION || version === V4_SCHEMA_VERSION || version === V3_SCHEMA_VERSION || version === V2_SCHEMA_VERSION ? version : null;
  } catch {
    return null;
  }
}

function queryFixture(logRoot, opts) {
  const order = opts.order === 'asc' ? 'asc' : 'desc';
  const limit = Math.min(500_000, Math.max(1, opts.limit ?? 500));
  const offset = Math.max(0, opts.offset ?? 0);
  const st = opts.startTime != null && opts.startTime > 0 ? opts.startTime : -8640000000000000;
  const et = opts.endTime != null && opts.endTime > 0 ? opts.endTime : 8640000000000000;
  const topicFilter = opts.topic && opts.topic.trim() ? opts.topic.trim() : null;
  const conditions = normalizeConditions(opts.conditions);
  const terms = conditions.length ? [] : parseKeywordTerms(opts.keywords?.length ? opts.keywords : (opts.keyword ? [opts.keyword] : []));
  const keywordLogic = opts.keywordLogic === 'or' ? 'or' : 'and';
  const filePath = path.join(logRoot, SAN_CONNECTION_ID, `${opts.fixtureFileKey || DAY}.db`);
  const out = [];
  let skipped = 0;
  const db = new Database(filePath, { readonly: true });
  try {
    const indexSchemaVersion = getUsableIndexVersion(db);
    if (indexSchemaVersion) {
      const hasOffsetColumns = indexSchemaVersion === V3_SCHEMA_VERSION || indexSchemaVersion === V4_SCHEMA_VERSION || indexSchemaVersion === V5_SCHEMA_VERSION;
      let sql = hasOffsetColumns
        ? 'SELECT bucket_ts, time_ms, topic, msg_index, search_text, payload_offset, payload_len FROM history_messages'
        : 'SELECT bucket_ts, time_ms, topic, msg_index, search_text FROM history_messages';
      const params = [];
      if (topicFilter) {
        sql += ' WHERE topic = ?';
        params.push(topicFilter);
      }
      sql += order === 'desc'
        ? ' ORDER BY time_ms DESC, topic DESC, msg_index DESC'
        : ' ORDER BY time_ms ASC, topic ASC, msg_index ASC';
      const rows = db.prepare(sql).all(...params);
      const bucketStmt = db.prepare('SELECT blob FROM buckets WHERE bucket_ts = ? AND topic = ?');
      const cache = new Map();
      for (const row of rows) {
        if (row.time_ms < st || row.time_ms > et) continue;
        if (!matchesSearchText(normalizeCombinedSearchText(row.topic, row.search_text), conditions, terms, keywordLogic)) continue;
        if (skipped < offset) { skipped++; continue; }
        const key = `${row.bucket_ts}\0${row.topic}`;
        const bucket = bucketStmt.get(row.bucket_ts, row.topic);
        if (!bucket) continue;
        let payload = null;
        if (hasOffsetColumns) {
          payload = readPayloadSlice(bucket.blob, row.payload_offset ?? -1, row.payload_len ?? -1);
        }
        if (payload == null) {
          let decoded = cache.get(key);
          if (!decoded) {
            decoded = decodeBucket(bucket.blob, row.bucket_ts, row.topic);
            cache.set(key, decoded);
          }
          payload = decoded[row.msg_index]?.payload ?? null;
        }
        if (payload != null) out.push({ connectionId: SAN_CONNECTION_ID, topic: row.topic, payload, time: row.time_ms });
        if (out.length >= limit) break;
      }
      return out;
    }

    let sql = 'SELECT bucket_ts, topic, blob FROM buckets';
    const params = [];
    if (topicFilter) {
      sql += ' WHERE topic = ?';
      params.push(topicFilter);
    }
    sql += order === 'desc' ? ' ORDER BY bucket_ts DESC, topic DESC' : ' ORDER BY bucket_ts ASC, topic ASC';
    const rows = db.prepare(sql).all(...params);
    for (const row of rows) {
      const decoded = decodeBucket(row.blob, row.bucket_ts, row.topic);
      const indexes = order === 'desc'
        ? [...decoded.keys()].reverse()
        : [...decoded.keys()];
      for (const index of indexes) {
        const item = decoded[index];
        if (item.time < st || item.time > et) continue;
        const searchText = normalizeCombinedSearchText(item.topic, item.payload);
        if (!matchesSearchText(searchText, conditions, terms, keywordLogic)) continue;
        if (skipped < offset) { skipped++; continue; }
        out.push({ connectionId: SAN_CONNECTION_ID, topic: item.topic, payload: item.payload, time: item.time });
        if (out.length >= limit) return out;
      }
    }
    return out;
  } finally {
    db.close();
  }
}

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label} mismatch\nexpected: ${e}\nactual:   ${a}`);
  }
}

function normalizeRows(rows) {
  return rows.map((row) => ({ topic: row.topic, payload: row.payload, time: row.time }));
}

function runBuiltWorker(logRoot, opts) {
  const workerPath = path.resolve('dist-electron/main/history-query-worker.js');
  const sourcePaths = [
    path.resolve('electron/main/history-query-worker.ts'),
    path.resolve('electron/main/history-index-schema.ts'),
    path.resolve('electron/main/history-query-common.ts')
  ];
  if (!fs.existsSync(workerPath)) return null;
  const workerMtime = fs.statSync(workerPath).mtimeMs;
  if (sourcePaths.some((sourcePath) => fs.existsSync(sourcePath) && fs.statSync(sourcePath).mtimeMs > workerMtime)) return null;
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: { opts, logRoot } });
    worker.once('message', (message) => {
      if (message?.type === 'done') resolve(message.data);
      else reject(new Error(message?.error || 'worker query failed'));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`worker exited with code ${code}`));
    });
  });
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttmountain-history-fixtures-'));
  try {
    const variants = [
      { name: 'v5-complete-index', options: { index: 'complete', schemaVersion: V5_SCHEMA_VERSION } },
      { name: 'v5-hourly-complete-index', fileKey: `${DAY}-09`, options: { index: 'complete', schemaVersion: V5_SCHEMA_VERSION } }
    ];

    for (const variant of variants) {
      const logRoot = path.join(tempRoot, variant.name);
      const dbPath = path.join(logRoot, SAN_CONNECTION_ID, `${variant.fileKey || DAY}.db`);
      buildFixtureDb(dbPath, variant.options);
      if (variant.options.metadataMismatch) {
        const db = new Database(dbPath, { readonly: true });
        try {
          const row = db.prepare('SELECT blob, count, bytes FROM buckets WHERE topic = ? ORDER BY bucket_ts LIMIT 1').get('sensor/temp');
          const validation = validateBucketBlob(row.blob, row.count, row.bytes);
          if (validation.valid || !validation.structureValid) throw new Error('metadata mismatch fixture did not produce a structurally valid suspicious bucket');
        } finally {
          db.close();
        }
      }

      for (const queryCase of QUERY_CASES) {
        const fixtureOpts = { ...queryCase.opts, connectionId: CONNECTION_ID, fixtureFileKey: variant.fileKey };
        const expected = normalizeRows(queryFixture(logRoot, fixtureOpts));
        const actual = normalizeRows(queryFixture(logRoot, fixtureOpts));
        assertDeepEqual(actual, expected, `${variant.name}/${queryCase.name}/reference`);

        const workerRows = await runBuiltWorker(logRoot, { ...queryCase.opts, connectionId: CONNECTION_ID });
        if (workerRows) {
          assertDeepEqual(normalizeRows(workerRows), expected, `${variant.name}/${queryCase.name}/built-worker`);
        }
      }
      console.log(`✓ ${variant.name}`);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    app?.exit(process.exitCode || 0);
  });
