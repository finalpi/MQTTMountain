import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const { app } = require('electron');
const Database = require('better-sqlite3');
const ts = require('typescript');
const workerPath = path.resolve('dist-electron/main/history-query-worker.js');
const workerSources = [
  'electron/main/history-query-worker.ts',
  'electron/main/history-query-common.ts',
  'electron/main/log-root-safety.ts',
  'electron/main/history-bucket-codec.ts',
  'electron/main/payload-codec.ts'
].map((item) => path.resolve(item));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertRows(actual, expected, label) {
  const slim = (rows) => rows.map(({ connectionId, topic, payload, time }) => ({ connectionId, topic, payload, time }));
  const a = JSON.stringify(slim(actual));
  const e = JSON.stringify(slim(expected));
  if (a !== e) throw new Error(`${label} mismatch\nexpected: ${e}\nactual:   ${a}`);
}

function ensureFreshWorkerBuild() {
  assert(fs.existsSync(workerPath), `missing ${workerPath}; run npx vite build first`);
  const builtAt = fs.statSync(workerPath).mtimeMs;
  assert(!workerSources.some((source) => fs.statSync(source).mtimeMs > builtAt), 'history query worker build is stale; run npx vite build first');
}

function encodeBucket(messages, bucketTs) {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(messages.length, 0);
  const parts = [head];
  const entries = [];
  let cursor = 4;
  for (const message of messages) {
    const payload = Buffer.from(message.payload, 'utf8');
    const meta = Buffer.alloc(6);
    meta.writeUInt16LE(message.time - bucketTs * 1000, 0);
    meta.writeUInt32LE(payload.length, 2);
    parts.push(meta, payload);
    entries.push({ payloadOffset: cursor + 6, payloadLen: payload.length, entryOffset: cursor, entryLen: 6 + payload.length });
    cursor += 6 + payload.length;
  }
  return { blob: Buffer.concat(parts), entries };
}

function buildDb(dbPath, messages, mode = 'complete') {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE buckets (
        bucket_ts INTEGER NOT NULL,
        topic TEXT NOT NULL,
        blob BLOB NOT NULL,
        count INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        PRIMARY KEY (bucket_ts, topic)
      ) WITHOUT ROWID;
      CREATE INDEX idx_buckets_ts ON buckets(bucket_ts);
    `);
    const grouped = new Map();
    for (const message of messages) {
      const bucketTs = Math.floor(message.time / 1000);
      const key = `${bucketTs}\0${message.topic}`;
      const group = grouped.get(key) || { bucketTs, topic: message.topic, messages: [] };
      group.messages.push(message);
      grouped.set(key, group);
    }
    const bucketInsert = db.prepare('INSERT INTO buckets(bucket_ts, topic, blob, count, bytes) VALUES (?, ?, ?, ?, ?)');
    const encodedGroups = [];
    for (const group of grouped.values()) {
      const encoded = encodeBucket(group.messages, group.bucketTs);
      bucketInsert.run(group.bucketTs, group.topic, encoded.blob, group.messages.length, encoded.blob.length);
      encodedGroups.push({ ...group, ...encoded });
    }
    if (mode === 'missing') return;

    db.exec(`
      CREATE TABLE history_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bucket_ts INTEGER NOT NULL,
        topic TEXT NOT NULL,
        msg_index INTEGER NOT NULL,
        time_ms INTEGER NOT NULL,
        payload_offset INTEGER NOT NULL,
        payload_len INTEGER NOT NULL,
        entry_offset INTEGER NOT NULL,
        entry_len INTEGER NOT NULL,
        UNIQUE (bucket_ts, topic, msg_index)
      );
      CREATE INDEX idx_history_messages_time_topic_msg ON history_messages(time_ms, topic, msg_index);
      CREATE INDEX idx_history_messages_topic_time_msg ON history_messages(topic, time_ms, msg_index);
      CREATE TABLE history_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE VIRTUAL TABLE history_messages_fts USING fts5(search_text, tokenize='trigram', content='', detail=none, columnsize=0);
    `);
    const meta = db.prepare('INSERT INTO history_index_meta(key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries({
      schema_version: '6',
      index_complete: mode === 'complete' ? '1' : '0',
      fts5_enabled: '1',
      fts5_tokenizer: 'trigram',
      fts_layout: 'contentless',
      fts_index_complete: '1'
    })) meta.run(key, value);
    const rowInsert = db.prepare(`
      INSERT INTO history_messages(bucket_ts, topic, msg_index, time_ms, payload_offset, payload_len, entry_offset, entry_len)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const ftsInsert = db.prepare('INSERT INTO history_messages_fts(rowid, search_text) VALUES (?, ?)');
    let indexedGroups = 0;
    for (const group of encodedGroups) {
      if (mode === 'incomplete' && indexedGroups++ > 0) continue;
      group.messages.forEach((message, index) => {
        const entry = group.entries[index];
        const result = rowInsert.run(group.bucketTs, group.topic, index, message.time, entry.payloadOffset, entry.payloadLen, entry.entryOffset, entry.entryLen);
        ftsInsert.run(result.lastInsertRowid, message.payload.replace(/\s+/gu, '').toLowerCase());
      });
    }
  } finally {
    db.close();
  }
}

function runWorker(logRoot, opts, stream = false) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let done = false;
    const worker = new Worker(workerPath, {
      workerData: { opts, logRoot, stream, requestId: stream ? 'regression-stream' : undefined, chunkSize: 100 }
    });
    worker.on('message', (message) => {
      if (message?.type === 'chunk') rows.push(...(message.rows || []));
      else if (message?.type === 'done') {
        done = true;
        resolve(stream ? rows : message.data);
      } else if (message?.type === 'error') reject(new Error(message.error || 'worker query failed'));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!done) reject(new Error(`worker exited without done (${code})`));
    });
  });
}

function loadHistoryQueryHarness(flushStorageAsync, onWorker) {
  const filename = path.resolve('electron/main/history-query.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText;
  class FakeWorker extends EventEmitter {
    constructor() {
      super();
      onWorker(this);
    }
    terminate() { return Promise.resolve(0); }
  }
  const module = { exports: {} };
  const localRequire = (id) => {
    if (id === 'node:path') return require(id);
    if (id === 'node:worker_threads') return { Worker: FakeWorker };
    if (id === './storage') return { flushStorageAsync, getLogRoot: () => 'fixture-root' };
    if (id === './diagnostics') return { writeDiagnosticLog: () => {} };
    if (id === './heavy-job-scheduler') {
      return { scheduleHeavyJob: (_meta, run) => ({ promise: Promise.resolve().then(run), cancel: () => {} }) };
    }
    throw new Error(`unexpected require: ${id}`);
  };
  const wrapper = vm.runInThisContext(`(function(require,module,exports,__dirname,__filename){${compiled}\n})`, { filename });
  wrapper(localRequire, module, module.exports, path.dirname(filename), filename);
  return module.exports;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function testLifecycle() {
  let releaseStrict;
  let strictWorkers = 0;
  const strictApi = loadHistoryQueryHarness(
    () => new Promise((resolve) => { releaseStrict = resolve; }),
    (worker) => { strictWorkers++; queueMicrotask(() => worker.emit('message', { type: 'done', data: [] })); }
  );
  const strictQuery = strictApi.queryHistoryAsync({ freshness: 'strict' });
  await delay(120);
  assert(strictWorkers === 0, 'strict freshness started worker before storage flush completed');
  releaseStrict();
  await strictQuery;
  assert(strictWorkers === 1, 'strict freshness did not start after storage flush');

  let bestEffortWorkers = 0;
  const bestEffortApi = loadHistoryQueryHarness(
    () => new Promise(() => {}),
    (worker) => { bestEffortWorkers++; queueMicrotask(() => worker.emit('message', { type: 'done', data: [] })); }
  );
  await bestEffortApi.queryHistoryAsync({ freshness: 'best-effort' });
  assert(bestEffortWorkers === 1, 'best-effort freshness did not keep bounded flush wait');

  const cleanExitApi = loadHistoryQueryHarness(
    () => Promise.resolve(),
    (worker) => queueMicrotask(() => worker.emit('exit', 0))
  );
  await assertRejects(cleanExitApi.queryHistoryAsync({ freshness: 'stale-ok' }), /未返回结果/u, 'clean worker exit');

  const streamEvents = [];
  cleanExitApi.startHistoryQueryStream(
    { isDestroyed: () => false, send: (channel, payload) => streamEvents.push({ channel, payload }) },
    { requestId: 'clean-stream', opts: { freshness: 'stale-ok' } }
  );
  await delay(20);
  assert(streamEvents.some((event) => event.channel === 'history:queryError' && /未返回结果/u.test(event.payload.message)), 'stream clean exit was not reported as an error');

  let releaseCancelled;
  let cancelledWorkers = 0;
  const cancelApi = loadHistoryQueryHarness(
    () => new Promise((resolve) => { releaseCancelled = resolve; }),
    () => { cancelledWorkers++; }
  );
  cancelApi.startHistoryQueryStream(
    { isDestroyed: () => false, send: () => {} },
    { requestId: 'cancel-during-flush', opts: { freshness: 'strict' } }
  );
  await delay(0);
  cancelApi.cancelHistoryQueryStream('cancel-during-flush');
  releaseCancelled();
  await delay(10);
  assert(cancelledWorkers === 0, 'cancelled stream created a worker after flush');
}

async function assertRejects(promise, pattern, label) {
  try {
    await promise;
  } catch (error) {
    assert(pattern.test(String(error?.message || error)), `${label} rejected with unexpected error: ${error}`);
    return;
  }
  throw new Error(`${label} unexpectedly resolved`);
}

async function main() {
  ensureFreshWorkerBuild();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttmountain-history-query-regressions-'));
  try {
    const base = new Date(2026, 8, 4, 10, 0, 0, 0).getTime();
    const fileKey = '2026-09-04-10';
    const a = [
      { topic: 'a/topic', payload: 'oldest-a', time: base + 100 },
      { topic: 'a/topic', payload: 'newest-a', time: base + 400 }
    ];
    const b = [
      { topic: 'b/topic', payload: 'older-b', time: base + 200 },
      { topic: 'b/topic', payload: 'newer-b', time: base + 300 }
    ];
    buildDb(path.join(tempRoot, 'conn-a', `${fileKey}.db`), a);
    buildDb(path.join(tempRoot, 'conn-b', `${fileKey}.db`), b);
    const expectedPage = [
      { connectionId: 'conn-b', ...b[1] },
      { connectionId: 'conn-b', ...b[0] }
    ];
    const pageOpts = { order: 'desc', offset: 1, limit: 2 };
    assertRows(await runWorker(tempRoot, pageOpts), expectedPage, 'all-connections array ordering');
    assertRows(await runWorker(tempRoot, pageOpts, true), expectedPage, 'all-connections stream ordering');

    const topicRoot = path.join(tempRoot, 'topic-only');
    const topicMessage = { topic: 'thing/product/hezhou', payload: 'payload without the searched words', time: base + 500 };
    buildDb(path.join(topicRoot, 'topic-conn', `${fileKey}.db`), [topicMessage]);
    assertRows(
      await runWorker(topicRoot, { keyword: 'thing/product', order: 'desc', limit: 10 }),
      [{ connectionId: 'topic-conn', ...topicMessage }],
      'v6 topic-only keyword'
    );

    for (const mode of ['incomplete', 'missing']) {
      const fallbackRoot = path.join(tempRoot, mode);
      const messages = [
        { topic: 'fallback/one', payload: `${mode}-one`, time: base + 600 },
        { topic: 'fallback/two', payload: `${mode}-two`, time: base + 1600 }
      ];
      buildDb(path.join(fallbackRoot, `${mode}-conn`, `${fileKey}.db`), messages, mode);
      assertRows(
        await runWorker(fallbackRoot, { order: 'asc', limit: 10 }),
        messages.map((message) => ({ connectionId: `${mode}-conn`, ...message })),
        `${mode} index raw fallback`
      );
    }

    await testLifecycle();
    console.log('✓ global ordering and global offset/limit (array + stream)');
    console.log('✓ incomplete and missing index raw fallback');
    console.log('✓ v6 topic-only keyword candidate union');
    console.log('✓ strict/best-effort freshness, clean exit, and cancel lifecycle');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => app?.exit(process.exitCode || 0));
