import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { app } = require('electron');
const Database = require('better-sqlite3');
const storageWorkerPath = path.resolve('dist-electron/main/storage-worker.js');
const queryWorkerPath = path.resolve('dist-electron/main/history-query-worker.js');
const indexWorkerPath = path.resolve('dist-electron/main/history-index-worker.js');

function shardKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}`;
}

function startStorage(logRoot, closedFtsIntervalMs = 60_000) {
  const worker = new Worker(storageWorkerPath, {
    workerData: { logRoot },
    env: { ...process.env, MQTTMOUNTAIN_CLOSED_FTS_INTERVAL_MS: String(closedFtsIntervalMs) }
  });
  let nextId = 0;
  const pending = new Map();
  worker.on('message', (message) => {
    if (message?.id == null) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message.result);
    else request.reject(new Error(message.error || 'storage worker request failed'));
  });
  const call = (command, payload, timeoutMs = 15_000) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, command, payload });
  });
  return { worker, call };
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out`);
}

async function stopStorage(handle, graceful = true) {
  if (graceful) await handle.call('shutdown').catch(() => undefined);
  await handle.worker.terminate();
}

function queryHistory(logRoot, opts) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(queryWorkerPath, { workerData: { logRoot, opts } });
    let settled = false;
    worker.on('message', (message) => {
      if (message?.type === 'diagnostic') return;
      if (message?.type === 'done') {
        settled = true;
        resolve(message.data);
      } else if (message?.type === 'error') {
        settled = true;
        reject(new Error(message.error || 'query failed'));
      }
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`query worker exited without result (${code})`));
    });
  });
}

function rebuildIndex(logRoot) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(indexWorkerPath, { workerData: { logRoot, req: {} } });
    let settled = false;
    worker.on('message', (message) => {
      if (message?.type === 'progress') return;
      if (message?.type === 'done') {
        settled = true;
        resolve(message.result);
      } else if (message?.type === 'error') {
        settled = true;
        reject(new Error(message.error || 'index rebuild failed'));
      }
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`index worker exited without result (${code})`));
    });
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttmountain-fts-cursor-regression-'));
  const connectionId = 'fixture';
  const now = new Date();
  now.setHours(now.getHours() - 1);
  now.setMinutes(10, 0, 0);
  const base = now.getTime();
  const dbPath = path.join(root, connectionId, `${shardKey(base)}.db`);
  let storage;
  try {
    storage = startStorage(root);
    await storage.call('enqueueBatch', [
      { connectionId, topic: 'cursor/test', payload: '{"text":"Alpha B eta"}', tsMs: base + 10 },
      { connectionId, topic: 'cursor/test', payload: '{"text":"Gamma"}', tsMs: base + 20 }
    ]);
    await stopStorage(storage, false);
    storage = null;

    let db = new Database(dbPath, { readonly: true, fileMustExist: true });
    let pendingColumns = db.prepare('PRAGMA table_info(history_fts_pending)').all().map((row) => row.name);
    let pendingCount = Number(db.prepare('SELECT COUNT(*) AS count FROM history_fts_pending').get().count);
    let complete = db.prepare("SELECT value FROM history_index_meta WHERE key = 'fts_index_complete'").get()?.value;
    db.close();
    if (pendingColumns.join(',') !== 'id' || pendingCount !== 2 || complete !== '0') {
      throw new Error(`id-only durable pending state mismatch: ${JSON.stringify({ pendingColumns, pendingCount, complete })}`);
    }

    storage = startStorage(root, 50);
    await waitFor(() => {
      try {
        const check = new Database(dbPath, { readonly: true, fileMustExist: true });
        try {
          return check.prepare("SELECT value FROM history_index_meta WHERE key = 'fts_index_complete'").get()?.value === '1';
        } finally { check.close(); }
      } catch { return false; }
    }, 10_000, 'restart FTS recovery');
    let flushed;
    let rows = await queryHistory(root, { connectionId, keyword: 'alpha beta', order: 'asc', limit: 10 });
    if (rows.length !== 1 || !rows[0].payload.includes('Alpha')) throw new Error(`exact normalized query failed after restart: ${JSON.stringify(rows)}`);
    console.log('✓ crash/restart rebuilds exact FTS text from id-only pending rows');

    await storage.call('enqueueBatch', [
      { connectionId, topic: 'cursor/test', payload: '{"text":"Late Delta"}', tsMs: base + 30 }
    ]);
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const idsBeforeRepair = db.prepare("SELECT id FROM history_messages WHERE topic = 'cursor/test' ORDER BY id").pluck().all();
    pendingCount = Number(db.prepare('SELECT COUNT(*) AS count FROM history_fts_pending').get().count);
    complete = db.prepare("SELECT value FROM history_index_meta WHERE key = 'fts_index_complete'").get()?.value;
    db.close();
    if (pendingCount !== 1 || complete !== '0' || idsBeforeRepair[2] <= idsBeforeRepair[1]) throw new Error('late append did not create a monotonic pending row');
    flushed = await storage.call('flushDeferredFts');
    rows = await queryHistory(root, { connectionId, keyword: 'late delta', order: 'asc', limit: 10 });
    if (Number(flushed.indexed) !== 1 || rows.length !== 1) throw new Error('late append FTS recovery failed');
    console.log('✓ late bucket append keeps old offsets and indexes the new AUTOINCREMENT row');

    await stopStorage(storage);
    storage = null;
    db = new Database(dbPath);
    db.prepare("DELETE FROM history_messages WHERE topic = 'cursor/test' AND msg_index = 1").run();
    db.close();
    storage = startStorage(root);
    await storage.call('enqueueBatch', [
      { connectionId, topic: 'cursor/test', payload: '{"text":"After Repair"}', tsMs: base + 40 }
    ]);
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const repairedIds = db.prepare("SELECT id FROM history_messages WHERE topic = 'cursor/test' ORDER BY msg_index").pluck().all();
    db.close();
    if (repairedIds.length !== 4 || Math.min(...repairedIds) <= Math.max(...idsBeforeRepair)) throw new Error('bucket index rewrite reused or retained old row IDs');
    await storage.call('flushDeferredFts');
    rows = await queryHistory(root, { connectionId, keyword: 'after repair', order: 'asc', limit: 10 });
    if (rows.length !== 1 || !rows[0].payload.includes('After Repair')) throw new Error('FTS query failed after bucket index rewrite');
    console.log('✓ bucket index rewrite replaces pending IDs without stale FTS query results');

    await stopStorage(storage);
    storage = null;
    db = new Database(dbPath);
    db.exec('DROP TABLE history_fts_pending; CREATE TABLE history_fts_pending(id INTEGER PRIMARY KEY, search_text TEXT NOT NULL);');
    db.close();
    storage = startStorage(root);
    await storage.call('enqueueBatch', [
      { connectionId, topic: 'legacy/pending', payload: '{"text":"Legacy Shape"}', tsMs: base + 1_010 }
    ]);
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const legacyPending = db.prepare('SELECT id, search_text FROM history_fts_pending').get();
    db.close();
    if (!legacyPending || legacyPending.search_text !== '') throw new Error(`legacy pending table duplicated payload text: ${JSON.stringify(legacyPending)}`);
    await storage.call('flushDeferredFts');
    rows = await queryHistory(root, { connectionId, keyword: 'legacy shape', order: 'asc', limit: 10 });
    if (rows.length !== 1) throw new Error('legacy v6 pending table shape failed derived indexing');
    console.log('✓ existing v6 pending table shape stays compatible without new text writes');

    await storage.call('enqueueBatch', [
      { connectionId, topic: 'corrupt/pending', payload: '{"text":"Corrupt Pending"}', tsMs: base + 2_010 }
    ]);
    await stopStorage(storage);
    storage = null;
    db = new Database(dbPath);
    const broken = Buffer.alloc(11);
    broken.write('MMZ1', 0);
    broken.writeUInt32LE(128, 4);
    broken.set([1, 2, 3], 8);
    db.prepare("UPDATE buckets SET blob = ?, bytes = ? WHERE topic = 'corrupt/pending'").run(broken, broken.length);
    db.prepare("INSERT INTO history_fts_pending(id, search_text) VALUES (999999, 'orphan')").run();
    db.close();
    storage = startStorage(root);
    await storage.call('enqueueBatch', [
      { connectionId, topic: 'healthy/control', payload: '{"text":"Healthy Control"}', tsMs: base + 3_010 }
    ]);
    flushed = await storage.call('flushDeferredFts');
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    pendingCount = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM history_fts_pending p
      JOIN history_messages m ON m.id = p.id
      WHERE m.topic = 'corrupt/pending'
    `).get().count);
    const corruptPendingId = Number(db.prepare(`
      SELECT MIN(p.id) AS id FROM history_fts_pending p
      JOIN history_messages m ON m.id = p.id
      WHERE m.topic = 'corrupt/pending'
    `).get().id);
    const totalPending = Number(db.prepare('SELECT COUNT(*) AS count FROM history_fts_pending').get().count);
    complete = db.prepare("SELECT value FROM history_index_meta WHERE key = 'fts_index_complete'").get()?.value;
    const cursor = Number(db.prepare("SELECT value FROM history_index_meta WHERE key = 'fts_indexed_id'").get()?.value || 0);
    db.close();
    if (pendingCount !== 1 || totalPending !== 1 || complete !== '0' || cursor >= corruptPendingId || Number(flushed.incompleteShards) < 1) {
      throw new Error(`corrupt bucket falsely advanced FTS completeness: ${JSON.stringify({ pendingCount, totalPending, complete, cursor, corruptPendingId, flushed })}`);
    }
    console.log('✓ corrupt bucket keeps its pending row and never reports FTS complete');

    await storage.call('enqueueBatch', [
      { connectionId, topic: 'corrupt/pending', payload: '{"text":"Recovered Bucket"}', tsMs: base + 2_020 }
    ]);
    await stopStorage(storage);
    storage = null;
    const rebuilt = await rebuildIndex(root);
    if (Number(rebuilt.incompleteFiles) !== 0) throw new Error(`index rebuild did not recover corrupt-pending shard: ${JSON.stringify(rebuilt)}`);
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    pendingCount = Number(db.prepare('SELECT COUNT(*) AS count FROM history_fts_pending').get().count);
    complete = db.prepare("SELECT value FROM history_index_meta WHERE key = 'fts_index_complete'").get()?.value;
    db.close();
    if (pendingCount !== 0 || complete !== '1') throw new Error('explicit index rebuild left pending/incomplete state');
    rows = await queryHistory(root, { connectionId, keyword: 'recovered bucket', order: 'asc', limit: 10 });
    if (rows.length !== 1) throw new Error('recovered bucket was not queryable after explicit rebuild');
    console.log('✓ damaged bucket quarantine plus paused index rebuild resets cursor/pending state atomically');
  } finally {
    if (storage) await stopStorage(storage).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => app?.exit(process.exitCode || 0));
