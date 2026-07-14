import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const { app } = require('electron');
const Database = require('better-sqlite3');

function queryHistory(logRoot, opts) {
  const workerPath = path.resolve('dist-electron/main/history-query-worker.js');
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: { logRoot, opts } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('history query worker timed out'));
    }, 15_000);
    worker.on('message', (message) => {
      if (message?.type === 'diagnostic') return;
      clearTimeout(timer);
      void worker.terminate();
      if (message?.type === 'done') resolve(message.data);
      else reject(new Error(message?.error || 'history query failed'));
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function run() {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttmountain-storage-shard-'));
  const tsMs = new Date(2026, 6, 14, 9, 23, 45, 123).getTime();
  const nextHourTsMs = new Date(2026, 6, 14, 10, 0, 0, 123).getTime();
  const workerPath = path.resolve('dist-electron/main/storage-worker.js');
  const expectedDb = path.join(logRoot, 'fixture', '2026-07-14-09.db');
  const rolloverLoadDb = path.join(logRoot, 'rollover-load', '2026-07-14-09.db');
  const worker = new Worker(workerPath, { workerData: { logRoot } });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('storage shard worker timed out')), 15_000);
      worker.on('message', async (message) => {
        if (message?.id === 1) {
          if (!message.ok) {
            clearTimeout(timer);
            reject(new Error(message.error || 'storage batch failed'));
            return;
          }
          try {
            const tailRows = await queryHistory(logRoot, {
              connectionId: 'fixture',
              keyword: 'optimized',
              order: 'asc',
              limit: 10
            });
            if (!Array.isArray(tailRows) || tailRows.length !== 1) {
              throw new Error(`expected incomplete FTS fallback to return 1 row, got ${Array.isArray(tailRows) ? tailRows.length : 'invalid result'}`);
            }
            worker.postMessage({ id: 3, command: 'flushDeferredFts' });
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        } else if (message?.id === 3) {
          if (!message.ok || message.result?.indexed !== 1 || message.result?.incompleteShards !== 0) {
            clearTimeout(timer);
            reject(new Error(`deferred FTS flush failed: ${JSON.stringify(message)}`));
            return;
          }
          worker.postMessage({
            id: 4,
            command: 'enqueueBatch',
            payload: [{ connectionId: 'fixture', topic: 'a/b', payload: '{"rollover":"sealed"}', tsMs: nextHourTsMs }]
          });
        } else if (message?.id === 4) {
          if (!message.ok) {
            clearTimeout(timer);
            reject(new Error(message.error || 'next-hour storage batch failed'));
            return;
          }
          worker.postMessage({
            id: 5,
            command: 'enqueueBatch',
            payload: Array.from({ length: 1500 }, (_, index) => ({
              connectionId: 'rollover-load',
              topic: 'load/test',
              payload: `{"index":${index},"text":"bounded rollover"}`,
              tsMs: tsMs + index
            }))
          });
        } else if (message?.id === 5) {
          if (!message.ok) {
            clearTimeout(timer);
            reject(new Error(message.error || 'rollover load storage batch failed'));
            return;
          }
          worker.postMessage({
            id: 6,
            command: 'enqueueBatch',
            payload: [{ connectionId: 'rollover-load', topic: 'load/test', payload: '{"rollover":"bounded"}', tsMs: nextHourTsMs }]
          });
        } else if (message?.id === 6) {
          if (!message.ok) {
            clearTimeout(timer);
            reject(new Error(message.error || 'bounded rollover storage batch failed'));
            return;
          }
          worker.postMessage({ id: 2, command: 'shutdown' });
        } else if (message?.id === 2) {
          clearTimeout(timer);
          if (message.ok) resolve();
          else reject(new Error(message.error || 'storage shutdown failed'));
        }
      });
      worker.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.postMessage({
        id: 1,
        command: 'enqueueBatch',
        payload: [{ connectionId: 'fixture', topic: 'a/b', payload: '{"status":"optimized"}', tsMs }]
      });
    });

    if (!fs.existsSync(expectedDb)) throw new Error(`hour shard was not created: ${expectedDb}`);
    const db = new Database(expectedDb, { readonly: true });
    try {
      const row = db.prepare('SELECT COALESCE(SUM(count), 0) AS count FROM buckets').get();
      if (Number(row?.count) !== 1) throw new Error(`expected 1 committed message, got ${row?.count}`);
      const meta = Object.fromEntries(db.prepare("SELECT key, value FROM history_index_meta WHERE key IN ('fts_layout', 'fts_index_complete', 'fts_indexed_id')").all().map((item) => [item.key, item.value]));
      if (meta.fts_layout !== 'contentless' || meta.fts_index_complete !== '1' || Number(meta.fts_indexed_id) !== 1) {
        throw new Error(`unexpected deferred FTS metadata: ${JSON.stringify(meta)}`);
      }
      const ftsCount = Number(db.prepare('SELECT COUNT(*) AS count FROM history_messages_fts').get()?.count);
      if (ftsCount !== 1) throw new Error(`expected 1 contentless FTS row, got ${ftsCount}`);
      const finalizedAt = Number(db.prepare("SELECT value FROM history_index_meta WHERE key = 'fts_finalized_at'").get()?.value || 0);
      if (finalizedAt <= 0) throw new Error('hour rollover did not finalize the previous shard');
    } finally {
      db.close();
    }
    const oldWalPath = `${expectedDb}-wal`;
    if (fs.existsSync(oldWalPath) && fs.statSync(oldWalPath).size !== 0) {
      throw new Error(`expected finalized shard WAL to be truncated, got ${fs.statSync(oldWalPath).size} bytes`);
    }
    const rolloverDb = new Database(rolloverLoadDb, { readonly: true });
    try {
      const messageCount = Number(rolloverDb.prepare('SELECT COUNT(*) AS count FROM history_messages').get()?.count);
      const ftsCount = Number(rolloverDb.prepare('SELECT COUNT(*) AS count FROM history_messages_fts').get()?.count);
      const finalizedAt = Number(rolloverDb.prepare("SELECT value FROM history_index_meta WHERE key = 'fts_finalized_at'").get()?.value || 0);
      if (messageCount !== 1500) throw new Error(`expected 1500 rollover load messages, got ${messageCount}`);
      if (ftsCount >= messageCount) throw new Error('incomplete rollover shard was unexpectedly indexed synchronously');
      if (finalizedAt > 0) throw new Error('incomplete rollover shard was unexpectedly finalized synchronously');
    } finally {
      rolloverDb.close();
    }
    fs.copyFileSync(expectedDb, path.join(logRoot, 'fixture', '2026-07-14.db'));
    const rows = await queryHistory(logRoot, {
      connectionId: 'fixture',
      keyword: 'optimized',
      order: 'asc',
      limit: 10
    });
    if (!Array.isArray(rows) || rows.length !== 2) {
      throw new Error(`expected daily and hourly files to both be queried, got ${Array.isArray(rows) ? rows.length : 'invalid result'}`);
    }
    console.log('✓ storage-hour-shard durable commit');
    console.log('✓ deferred contentless FTS and incomplete-tail fallback');
    console.log('✓ completed hour rollover WAL truncate');
    console.log('✓ incomplete hour rollover stays bounded and defers FTS catch-up');
    console.log('✓ legacy-daily and hourly query compatibility');
  } finally {
    await worker.terminate().catch(() => undefined);
    fs.rmSync(logRoot, { recursive: true, force: true });
  }
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    app?.exit(process.exitCode || 0);
  });
