import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const { app } = require('electron');
const Database = require('better-sqlite3');

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out`);
}

function queryHistory(logRoot, opts) {
  const workerPath = path.resolve('dist-electron/main/history-query-worker.js');
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: { logRoot, opts } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('history query worker timed out'));
    }, 30_000);
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

function rebuildHistoryIndex(logRoot) {
  const workerPath = path.resolve('dist-electron/main/history-index-worker.js');
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: { logRoot, req: {} } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('history index rebuild timed out'));
    }, 30_000);
    worker.on('message', (message) => {
      if (message?.type === 'progress') return;
      clearTimeout(timer);
      void worker.terminate();
      if (message?.type === 'done') resolve(message.result);
      else reject(new Error(message?.error || 'history index rebuild failed'));
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function exportHistory(logRoot, targetPath) {
  const workerPath = path.resolve('dist-electron/main/history-export-worker.js');
  const req = {
    format: 'json',
    query: { connectionId: 'fixture' },
    conditions: [{ join: 'and', term: 'optimized' }]
  };
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: { logRoot, targetPath, req } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('compressed history export timed out'));
    }, 30_000);
    worker.on('message', (message) => {
      if (message?.type === 'progress') return;
      clearTimeout(timer);
      void worker.terminate();
      if (message?.type === 'done') resolve(message.result);
      else reject(new Error(message?.error || 'compressed history export failed'));
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
  const worker = new Worker(workerPath, {
    workerData: { logRoot },
    env: {
      ...process.env,
      MQTTMOUNTAIN_CLOSED_FTS_INTERVAL_MS: '50',
      MQTTMOUNTAIN_CLOSED_FTS_BATCH_ENTRIES: '500'
    }
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('storage shard worker timed out')), 60_000);
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
          if (!message.ok || ![0, 2].includes(message.result?.indexed) || message.result?.incompleteShards !== 0) {
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
          await waitFor(() => {
            if (!fs.existsSync(expectedDb)) return false;
            try {
              const checkDb = new Database(expectedDb, { readonly: true, fileMustExist: true });
              try {
                return checkDb.prepare("SELECT value FROM history_index_meta WHERE key = 'topic_stats_complete'").get()?.value === '1';
              } finally {
                checkDb.close();
              }
            } catch { return false; }
          }, 5_000, 'background topic stats finalization');
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
        payload: [
          { connectionId: 'fixture', topic: 'a/b', payload: JSON.stringify({ status: 'optimized', repeated: 'mqtt-storage-compression-'.repeat(40) }), tsMs },
          { connectionId: 'fixture', topic: 'a/b', payload: JSON.stringify({ status: 'opt pti tim imi miz ize zed', repeated: 'mqtt-storage-compression-'.repeat(40) }), tsMs: tsMs + 1 }
        ]
      });
    });

    if (!fs.existsSync(expectedDb)) throw new Error(`hour shard was not created: ${expectedDb}`);
    const db = new Database(expectedDb, { readonly: true });
    try {
      const row = db.prepare('SELECT COALESCE(SUM(count), 0) AS count FROM buckets').get();
      if (Number(row?.count) !== 2) throw new Error(`expected 2 committed messages, got ${row?.count}`);
      const meta = Object.fromEntries(db.prepare("SELECT key, value FROM history_index_meta WHERE key IN ('schema_version', 'fts_layout', 'fts_query_mode', 'fts_index_complete', 'fts_indexed_id', 'topic_stats_complete')").all().map((item) => [item.key, item.value]));
      if (meta.schema_version !== '6' || meta.fts_layout !== 'contentless' || meta.fts_query_mode !== 'compact-trigram-candidates' || meta.fts_index_complete !== '1' || Number(meta.fts_indexed_id) !== 2 || meta.topic_stats_complete !== '1') {
        throw new Error(`unexpected deferred FTS metadata: ${JSON.stringify(meta)}`);
      }
      const topicStats = db.prepare("SELECT count, latest_time FROM history_topic_stats WHERE topic = 'a/b'").get();
      if (Number(topicStats?.count) !== 2 || Number(topicStats?.latest_time) !== tsMs + 1) {
        throw new Error(`unexpected finalized topic stats: ${JSON.stringify(topicStats)}`);
      }
      const columns = db.prepare('PRAGMA table_info(history_messages)').all().map((item) => item.name);
      if (columns.includes('search_text')) throw new Error('v6 history_messages unexpectedly retains search_text');
      const pendingColumns = db.prepare('PRAGMA table_info(history_fts_pending)').all().map((item) => item.name);
      if (pendingColumns.join(',') !== 'id') throw new Error(`v6 pending table unexpectedly persists search text: ${pendingColumns.join(',')}`);
      const pendingCount = Number(db.prepare('SELECT COUNT(*) AS count FROM history_fts_pending').get()?.count);
      if (pendingCount !== 0) throw new Error(`expected pending FTS text to be deleted, got ${pendingCount}`);
      const ftsSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'history_messages_fts'").get()?.sql || '').toLowerCase();
      if (!ftsSql.includes('detail=none') || !ftsSql.includes('columnsize=0')) throw new Error(`FTS is not compact: ${ftsSql}`);
      const bucket = db.prepare('SELECT blob, bytes FROM buckets LIMIT 1').get();
      if (!Buffer.isBuffer(bucket?.blob) || bucket.blob.subarray(0, 4).toString('ascii') !== 'MMZ1') throw new Error('new bucket was not compressed');
      if (Number(bucket.bytes) !== bucket.blob.length) throw new Error('compressed bucket bytes metadata mismatch');
      const rawBytes = bucket.blob.readUInt32LE(4);
      if (bucket.blob.length / rawBytes >= 0.5) throw new Error(`unexpected bucket compression ratio: ${bucket.blob.length}/${rawBytes}`);
      const ftsRows = db.prepare(`SELECT rowid FROM history_messages_fts WHERE history_messages_fts MATCH '"opt"'`).all();
      if (ftsRows.length !== 2) throw new Error(`expected 2 compact FTS candidates for exact filtering, got ${ftsRows.length}`);
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
      const pendingFtsCount = Number(rolloverDb.prepare('SELECT COUNT(*) AS count FROM history_fts_pending').get()?.count);
      const finalizedAt = Number(rolloverDb.prepare("SELECT value FROM history_index_meta WHERE key = 'fts_finalized_at'").get()?.value || 0);
      const topicStatsComplete = rolloverDb.prepare("SELECT value FROM history_index_meta WHERE key = 'topic_stats_complete'").get()?.value;
      if (messageCount !== 1500) throw new Error(`expected 1500 rollover load messages, got ${messageCount}`);
      if (pendingFtsCount <= 0) throw new Error('incomplete rollover shard unexpectedly has no deferred FTS rows');
      if (finalizedAt > 0) throw new Error('incomplete rollover shard was unexpectedly finalized synchronously');
      if (topicStatsComplete === '1') throw new Error('open/incomplete rollover shard unexpectedly exposed complete topic stats');
    } finally {
      rolloverDb.close();
    }
    const rebuild = await rebuildHistoryIndex(logRoot);
    if (Number(rebuild?.incompleteFiles) !== 0 || Number(rebuild?.indexedFiles) < 3) {
      throw new Error(`v6 history index rebuild failed: ${JSON.stringify(rebuild)}`);
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
    const exportPath = path.join(logRoot, 'compressed-history.json');
    const exported = await exportHistory(logRoot, exportPath);
    if (Number(exported?.totalRows) !== 2 || !fs.readFileSync(exportPath, 'utf8').includes('optimized')) {
      throw new Error(`compressed history export failed: ${JSON.stringify(exported)}`);
    }
    console.log('✓ storage-hour-shard durable commit');
    console.log('✓ compressed bucket and v6 compact trigram schema');
    console.log('✓ deferred contentless FTS and incomplete-tail fallback');
    console.log('✓ completed hour rollover WAL truncate');
    console.log('✓ incomplete hour rollover stays bounded and defers FTS catch-up');
    console.log('✓ v6 index rebuild keeps compact FTS and compressed buckets');
    console.log('✓ compressed history export compatibility');
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
