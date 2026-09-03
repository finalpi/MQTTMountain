import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { app } = require('electron');
const Database = require('better-sqlite3');
const MESSAGE_COUNT = 20_000;
const BATCH_SIZE = 500;

function normalize(value) {
  return String(value).replace(/\s+/gu, '').toLowerCase();
}

function packBucket(messages, bucketSec) {
  const parts = [Buffer.alloc(4)];
  parts[0].writeUInt32LE(messages.length, 0);
  const offsets = [];
  let cursor = 4;
  for (const message of messages) {
    const payload = Buffer.from(message.payload);
    const meta = Buffer.alloc(6);
    meta.writeUInt16LE(message.time - bucketSec * 1000, 0);
    meta.writeUInt32LE(payload.length, 2);
    parts.push(meta, payload);
    offsets.push({ payloadOffset: cursor + 6, payloadLen: payload.length });
    cursor += 6 + payload.length;
  }
  const raw = Buffer.concat(parts);
  const compressed = zlib.deflateRawSync(raw, { level: 1 });
  const header = Buffer.alloc(8);
  header.write('MMZ1', 0);
  header.writeUInt32LE(raw.length, 4);
  return { blob: Buffer.concat([header, compressed]), offsets };
}

function unpackBucket(blob) {
  if (blob.subarray(0, 4).toString() !== 'MMZ1') return blob;
  return zlib.inflateRawSync(blob.subarray(8));
}

function validateRawBucket(raw, expectedCount, expectedBytes, storedBytes) {
  if (storedBytes !== expectedBytes || raw.length < 4 || raw.readUInt32LE(0) !== expectedCount) return false;
  let offset = 4;
  for (let index = 0; index < expectedCount; index++) {
    if (offset + 6 > raw.length) return false;
    const length = raw.readUInt32LE(offset + 2);
    offset += 6 + length;
    if (offset > raw.length) return false;
  }
  return offset === raw.length;
}

function createFixture(filePath, storesText) {
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE buckets(bucket_ts INTEGER NOT NULL, topic TEXT NOT NULL, blob BLOB NOT NULL, count INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(bucket_ts, topic)) WITHOUT ROWID;
    CREATE TABLE history_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, bucket_ts INTEGER NOT NULL, topic TEXT NOT NULL, msg_index INTEGER NOT NULL, time_ms INTEGER NOT NULL, payload_offset INTEGER NOT NULL, payload_len INTEGER NOT NULL, entry_offset INTEGER NOT NULL, entry_len INTEGER NOT NULL, UNIQUE(bucket_ts, topic, msg_index));
    CREATE INDEX idx_history_messages_topic_time_msg ON history_messages(topic, time_ms, msg_index);
    CREATE TABLE history_fts_pending(id INTEGER PRIMARY KEY${storesText ? ', search_text TEXT NOT NULL' : ''});
    CREATE VIRTUAL TABLE history_messages_fts USING fts5(search_text, tokenize='trigram', content='', detail=none, columnsize=0);
  `);
  const insertBucket = db.prepare('INSERT INTO buckets VALUES (?, ?, ?, ?, ?)');
  const insertMessage = db.prepare('INSERT INTO history_messages(bucket_ts, topic, msg_index, time_ms, payload_offset, payload_len, entry_offset, entry_len) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertPending = storesText
    ? db.prepare('INSERT INTO history_fts_pending(id, search_text) VALUES (?, ?)')
    : db.prepare('INSERT INTO history_fts_pending(id) VALUES (?)');
  const base = 1_780_000_000_000;
  db.transaction(() => {
    for (let bucketIndex = 0; bucketIndex < MESSAGE_COUNT / 50; bucketIndex++) {
      const bucketSec = Math.floor(base / 1000) + bucketIndex;
      const topic = `telemetry/topic/${bucketIndex % 20}`;
      const messages = Array.from({ length: 50 }, (_, offset) => ({
        time: bucketSec * 1000 + offset,
        payload: JSON.stringify({ bucketIndex, offset, text: 'telemetry sample payload '.repeat(40) })
      }));
      const packed = packBucket(messages, bucketSec);
      insertBucket.run(bucketSec, topic, packed.blob, messages.length, packed.blob.length);
      messages.forEach((message, index) => {
        const location = packed.offsets[index];
        const result = insertMessage.run(bucketSec, topic, index, message.time, location.payloadOffset, location.payloadLen, location.payloadOffset - 6, location.payloadLen + 6);
        if (storesText) insertPending.run(result.lastInsertRowid, normalize(message.payload));
        else insertPending.run(result.lastInsertRowid);
      });
    }
  })();
  db.pragma('wal_checkpoint(TRUNCATE)');
  const pendingBytes = Number(db.prepare("SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name = 'history_fts_pending'").get().bytes);
  const totalBytes = fs.statSync(filePath).size;
  db.close();
  return { pendingBytes, totalBytes };
}

function indexLegacyText(filePath) {
  const db = new Database(filePath);
  const insertFts = db.prepare('INSERT INTO history_messages_fts(rowid, search_text) VALUES (?, ?)');
  const deletePending = db.prepare('DELETE FROM history_fts_pending WHERE id = ?');
  const startedAt = performance.now();
  for (;;) {
    const rows = db.prepare('SELECT id, search_text FROM history_fts_pending ORDER BY id LIMIT ?').all(BATCH_SIZE);
    if (!rows.length) break;
    db.transaction(() => {
      for (const row of rows) {
        insertFts.run(row.id, row.search_text);
        deletePending.run(row.id);
      }
    })();
  }
  const elapsedMs = performance.now() - startedAt;
  const indexed = Number(db.prepare(`SELECT COUNT(*) AS count FROM history_messages_fts WHERE history_messages_fts MATCH '"tel"'`).get().count);
  db.close();
  return { elapsedMs, indexed };
}

function indexDerivedText(filePath) {
  const db = new Database(filePath);
  const bucketStmt = db.prepare('SELECT blob, count, bytes FROM buckets WHERE bucket_ts = ? AND topic = ?');
  const insertFts = db.prepare('INSERT INTO history_messages_fts(rowid, search_text) VALUES (?, ?)');
  const deletePending = db.prepare('DELETE FROM history_fts_pending WHERE id = ?');
  const startedAt = performance.now();
  for (;;) {
    const rows = db.prepare(`
      SELECT p.id, m.bucket_ts, m.topic, m.payload_offset, m.payload_len
      FROM history_fts_pending p JOIN history_messages m ON m.id = p.id
      ORDER BY p.id LIMIT ?
    `).all(BATCH_SIZE);
    if (!rows.length) break;
    const groups = new Map();
    for (const row of rows) {
      const key = `${row.bucket_ts}\0${row.topic}`;
      const group = groups.get(key) || { bucketTs: row.bucket_ts, topic: row.topic, rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }
    const derived = [];
    for (const group of groups.values()) {
      const bucket = bucketStmt.get(group.bucketTs, group.topic);
      const raw = unpackBucket(bucket.blob);
      if (!validateRawBucket(raw, bucket.count, bucket.bytes, bucket.blob.length)) throw new Error('benchmark bucket validation failed');
      for (const row of group.rows) {
        derived.push({ id: row.id, text: normalize(raw.subarray(row.payload_offset, row.payload_offset + row.payload_len).toString('utf8')) });
      }
    }
    db.transaction(() => {
      for (const row of derived) {
        insertFts.run(row.id, row.text);
        deletePending.run(row.id);
      }
    })();
  }
  const elapsedMs = performance.now() - startedAt;
  const indexed = Number(db.prepare(`SELECT COUNT(*) AS count FROM history_messages_fts WHERE history_messages_fts MATCH '"tel"'`).get().count);
  db.close();
  return { elapsedMs, indexed };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttmountain-fts-pending-performance-'));
try {
  const oldPath = path.join(root, 'full-text.db');
  const nextPath = path.join(root, 'id-only.db');
  const oldStorage = createFixture(oldPath, true);
  const nextStorage = createFixture(nextPath, false);
  const oldIndex = indexLegacyText(oldPath);
  const nextIndex = indexDerivedText(nextPath);
  if (oldIndex.indexed !== MESSAGE_COUNT || nextIndex.indexed !== MESSAGE_COUNT) throw new Error(`FTS result count mismatch: ${oldIndex.indexed}/${nextIndex.indexed}`);
  if (nextStorage.pendingBytes * 20 >= oldStorage.pendingBytes) throw new Error(`pending storage reduction below 95%: ${oldStorage.pendingBytes} -> ${nextStorage.pendingBytes}`);
  console.log(JSON.stringify({
    messages: MESSAGE_COUNT,
    before: { ...oldStorage, indexMs: Number(oldIndex.elapsedMs.toFixed(1)) },
    after: { ...nextStorage, indexMs: Number(nextIndex.elapsedMs.toFixed(1)) },
    pendingBytesReductionPercent: Number(((1 - nextStorage.pendingBytes / oldStorage.pendingBytes) * 100).toFixed(1)),
    totalDbBytesReductionPercent: Number(((1 - nextStorage.totalBytes / oldStorage.totalBytes) * 100).toFixed(1)),
    derivedIndexTimeRatio: Number((nextIndex.elapsedMs / oldIndex.elapsedMs).toFixed(2))
  }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  app?.exit(process.exitCode || 0);
}
