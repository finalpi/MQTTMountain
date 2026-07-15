import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CONNECTION_ID = 'indexed-fixture';
const FALLBACK_CONNECTION_ID = 'fallback-fixture';
const TOPIC = 'fixture/compressed';
const LEGACY_TOPIC = 'fixture/uncompressed';
const BUCKET_SEC = Math.floor(new Date(2026, 6, 15, 9, 34, 0).getTime() / 1000);

function encodeRawBucket(items) {
  const chunks = [];
  const entries = [];
  let cursor = 4;
  for (const item of items) {
    const payload = Buffer.from(item.payload, 'utf8');
    const header = Buffer.alloc(6);
    header.writeUInt16LE(item.offset, 0);
    header.writeUInt32LE(payload.length, 2);
    entries.push({ payloadOffset: cursor + 6, payloadLen: payload.length, time: BUCKET_SEC * 1000 + item.offset });
    chunks.push(header, payload);
    cursor += header.length + payload.length;
  }
  const count = Buffer.alloc(4);
  count.writeUInt32LE(items.length, 0);
  return { raw: Buffer.concat([count, ...chunks]), entries };
}

function compressBucket(raw) {
  const header = Buffer.alloc(8);
  header.write('MMZ1', 0, 'ascii');
  header.writeUInt32LE(raw.length, 4);
  return Buffer.concat([header, deflateRawSync(raw, { level: 1 })]);
}

function createBucketsTable(db) {
  db.exec(`CREATE TABLE buckets (
    bucket_ts INTEGER NOT NULL,
    topic TEXT NOT NULL,
    blob BLOB NOT NULL,
    count INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    PRIMARY KEY(bucket_ts, topic)
  )`);
}

function createIndexedFixture(logRoot) {
  const dir = path.join(logRoot, CONNECTION_ID);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, '2026-07-15-09.db'));
  try {
    createBucketsTable(db);
    db.exec(`
      CREATE TABLE history_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE history_messages (
        bucket_ts INTEGER NOT NULL,
        time_ms INTEGER NOT NULL,
        topic TEXT NOT NULL,
        msg_index INTEGER NOT NULL,
        payload_offset INTEGER,
        payload_len INTEGER
      );
    `);
    const compressed = encodeRawBucket([
      { offset: 120, payload: '{"kind":"compressed-marker","value":1}' },
      { offset: 450, payload: '{"kind":"second-compressed","value":2}' }
    ]);
    const compressedBlob = compressBucket(compressed.raw);
    const legacy = encodeRawBucket([{ offset: 700, payload: '{"kind":"legacy-marker"}' }]);
    const insertBucket = db.prepare('INSERT INTO buckets(bucket_ts, topic, blob, count, bytes) VALUES (?, ?, ?, ?, ?)');
    insertBucket.run(BUCKET_SEC, TOPIC, compressedBlob, compressed.entries.length, compressedBlob.length);
    insertBucket.run(BUCKET_SEC, LEGACY_TOPIC, legacy.raw, legacy.entries.length, legacy.raw.length);
    const insertIndex = db.prepare('INSERT INTO history_messages(bucket_ts, time_ms, topic, msg_index, payload_offset, payload_len) VALUES (?, ?, ?, ?, ?, ?)');
    compressed.entries.forEach((entry, index) => insertIndex.run(BUCKET_SEC, entry.time, TOPIC, index, entry.payloadOffset, entry.payloadLen));
    legacy.entries.forEach((entry, index) => insertIndex.run(BUCKET_SEC, entry.time, LEGACY_TOPIC, index, entry.payloadOffset, entry.payloadLen));
    db.prepare('INSERT INTO history_index_meta(key, value) VALUES (?, ?)').run('schema_version', '6');
    db.prepare('INSERT INTO history_index_meta(key, value) VALUES (?, ?)').run('index_complete', '1');
    db.prepare('INSERT INTO history_index_meta(key, value) VALUES (?, ?)').run('fts5_enabled', '0');
  } finally {
    db.close();
  }
}

function createFallbackFixture(logRoot) {
  const dir = path.join(logRoot, FALLBACK_CONNECTION_ID);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, '2026-07-15-09.db'));
  try {
    createBucketsTable(db);
    const bucket = encodeRawBucket([{ offset: 900, payload: '{"kind":"fallback-compressed-marker"}' }]);
    const blob = compressBucket(bucket.raw);
    db.prepare('INSERT INTO buckets(bucket_ts, topic, blob, count, bytes) VALUES (?, ?, ?, ?, ?)')
      .run(BUCKET_SEC, TOPIC, blob, 1, blob.length);
  } finally {
    db.close();
  }
}

function toolJson(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('MCP tool returned no JSON text');
  return JSON.parse(text);
}

function expectPayload(result, marker) {
  const payloads = result.messages?.map((item) => item.payload) ?? [];
  if (!payloads.some((payload) => String(payload).includes(marker))) {
    throw new Error(`expected payload marker ${marker}, got ${JSON.stringify(payloads)}`);
  }
}

async function run() {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttmountain-mcp-compressed-'));
  createIndexedFixture(logRoot);
  createFallbackFixture(logRoot);
  const serverPath = path.resolve('bin/server.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath, '--log-dir', logRoot] });
  const client = new Client({ name: 'mqttmountain-mcp-compressed-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const compressed = toolJson(await client.callTool({
      name: 'mqttmountain_query_history',
      arguments: { connectionId: CONNECTION_ID, keyword: 'compressed-marker', payloadMode: 'full', limit: 10 }
    }));
    expectPayload(compressed, 'compressed-marker');
    const legacy = toolJson(await client.callTool({
      name: 'mqttmountain_query_history',
      arguments: { connectionId: CONNECTION_ID, topic: LEGACY_TOPIC, payloadMode: 'full', limit: 10 }
    }));
    expectPayload(legacy, 'legacy-marker');
    const fallback = toolJson(await client.callTool({
      name: 'mqttmountain_query_history',
      arguments: { connectionId: FALLBACK_CONNECTION_ID, keyword: 'fallback-compressed-marker', payloadMode: 'full', limit: 10 }
    }));
    expectPayload(fallback, 'fallback-compressed-marker');
    const recent = toolJson(await client.callTool({
      name: 'mqttmountain_recent_messages',
      arguments: { connectionId: CONNECTION_ID, topic: TOPIC, limit: 10 }
    }));
    expectPayload(recent, 'second-compressed');
    console.log('✓ v6 compressed indexed payload query');
    console.log('✓ legacy uncompressed payload query');
    console.log('✓ compressed bucket fallback query');
    console.log('✓ compressed recent-message query');
  } finally {
    await client.close().catch(() => undefined);
    fs.rmSync(logRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
