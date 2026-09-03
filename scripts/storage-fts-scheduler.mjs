import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { app } = require('electron');
const Database = require('better-sqlite3');
const workerPath = path.resolve('dist-electron/main/storage-worker.js');

class HourBoundaryRetryError extends Error {}

function shardKey(tsMs) {
  const d = new Date(tsMs);
  const pad = (value) => String(value).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}`;
}

function createWorker(logRoot, intervalMs, batchEntries) {
  return new Worker(workerPath, {
    workerData: { logRoot },
    env: {
      ...process.env,
      MQTTMOUNTAIN_CLOSED_FTS_INTERVAL_MS: String(intervalMs),
      MQTTMOUNTAIN_CLOSED_FTS_BATCH_ENTRIES: String(batchEntries)
    }
  });
}

function rpc(worker, id, command, payload, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off('message', onMessage);
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    const onMessage = (message) => {
      if (message?.id !== id) return;
      clearTimeout(timer);
      worker.off('message', onMessage);
      if (message.ok) resolve(message.result);
      else reject(new Error(message.error || `${command} failed`));
    };
    worker.on('message', onMessage);
    worker.postMessage({ id, command, payload });
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} timed out`);
}

function readMeta(dbPath, key) {
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT value FROM history_index_meta WHERE key = ?').get(key)?.value ?? null;
  } finally {
    db.close();
  }
}

async function runAttempt() {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttmountain-fts-scheduler-'));
  const connectionId = 'fixture';
  const currentHour = new Date();
  currentHour.setMinutes(0, 0, 0);
  const currentTs = currentHour.getTime() + 5 * 60_000;
  const currentShardKey = shardKey(currentTs);
  const oldTs = currentTs - 60 * 60_000;
  const oldDbPath = path.join(logRoot, connectionId, `${shardKey(oldTs)}.db`);
  const currentDbPath = path.join(logRoot, connectionId, `${shardKey(currentTs)}.db`);
  let worker = createWorker(logRoot, 60_000, 500);
  try {
    const oldBatch = Array.from({ length: 2500 }, (_, index) => ({
      connectionId,
      topic: 'load/old',
      payload: `{"kind":"old","index":${index},"text":"closed shard search payload"}`,
      tsMs: oldTs + index
    }));
    await rpc(worker, 1, 'enqueueBatch', oldBatch);
    await rpc(worker, 2, 'shutdown');
    await worker.terminate();
    worker = null;

    const oldPendingBefore = Number(readMeta(oldDbPath, 'fts_index_complete') === '0');
    if (oldPendingBefore !== 1) throw new Error('old fixture unexpectedly completed FTS before catchup');

    if (shardKey(Date.now()) !== currentShardKey) {
      throw new HourBoundaryRetryError('wall clock crossed an hour before the realtime fixture was written');
    }

    worker = createWorker(logRoot, 50, 500);
    const currentBatch = Array.from({ length: 1000 }, (_, index) => ({
      connectionId,
      topic: 'load/current',
      payload: `{"kind":"current","index":${index},"text":"realtime payload"}`,
      tsMs: currentTs + index
    }));
    await rpc(worker, 3, 'enqueueBatch', currentBatch);
    await waitFor(() => Number(readMeta(oldDbPath, 'fts_finalized_at') || 0) > 0, 15_000, 'closed FTS finalization');
    const diagnostics = await rpc(worker, 4, 'diagnostics');
    if (shardKey(Date.now()) !== currentShardKey) {
      throw new HourBoundaryRetryError('wall clock crossed an hour while the closed shard was indexed');
    }
    if (Number(diagnostics.closedFtsCandidateScans) !== 1) {
      throw new Error(`closed shard candidates were rescanned unexpectedly: ${diagnostics.closedFtsCandidateScans}`);
    }
    if (Number(diagnostics.deferredFtsIndexedEntries) < 2500) {
      throw new Error(`closed FTS diagnostics lost indexed entries: ${diagnostics.deferredFtsIndexedEntries}`);
    }
    if (Number(diagnostics.closedFtsCycles) < 2 || Number(diagnostics.closedFtsBatchEntries) === 500) {
      throw new Error(`closed FTS batch size did not adapt from the 500-entry start: ${JSON.stringify({
        cycles: diagnostics.closedFtsCycles,
        batchEntries: diagnostics.closedFtsBatchEntries
      })}`);
    }

    const oldDb = new Database(oldDbPath, { readonly: true, fileMustExist: true });
    try {
      const pending = Number(oldDb.prepare('SELECT COUNT(*) AS count FROM history_fts_pending').get().count);
      const indexed = Number(oldDb.prepare(`SELECT COUNT(*) AS count FROM history_messages_fts WHERE history_messages_fts MATCH '"clo"'`).get().count);
      const topicStatsComplete = oldDb.prepare("SELECT value FROM history_index_meta WHERE key = 'topic_stats_complete'").get()?.value;
      const topicStats = oldDb.prepare("SELECT count, latest_time FROM history_topic_stats WHERE topic = 'load/old'").get();
      if (pending !== 0 || indexed !== 2500) {
        throw new Error(`closed FTS catchup mismatch: pending=${pending}, indexed=${indexed}`);
      }
      if (topicStatsComplete !== '1' || Number(topicStats?.count) !== 2500 || Number(topicStats?.latest_time) !== oldTs + 2499) {
        throw new Error(`closed topic stats mismatch: complete=${topicStatsComplete}, stats=${JSON.stringify(topicStats)}`);
      }
    } finally {
      oldDb.close();
    }

    const currentDb = new Database(currentDbPath, { readonly: true, fileMustExist: true });
    try {
      const messages = Number(currentDb.prepare('SELECT COUNT(*) AS count FROM history_messages').get().count);
      const pending = Number(currentDb.prepare('SELECT COUNT(*) AS count FROM history_fts_pending').get().count);
      const indexed = Number(currentDb.prepare(`SELECT COUNT(*) AS count FROM history_messages_fts WHERE history_messages_fts MATCH '"rea"'`).get().count);
      if (messages !== 1000 || pending !== 1000 || indexed !== 0) {
        throw new Error(`realtime FTS should remain deferred: messages=${messages}, pending=${pending}, indexed=${indexed}`);
      }
    } finally {
      currentDb.close();
    }
    console.log('✓ closed shard FTS catches up in adaptive batches');
    console.log(`✓ closed FTS batch adapts from 500 to ${diagnostics.closedFtsBatchEntries} entries`);
    console.log('✓ closed shard candidates are scanned once and reused across batches');
    console.log('✓ current-hour FTS stays deferred while messages remain durable');
  } finally {
    if (worker) {
      await rpc(worker, 99, 'shutdown', undefined, 10_000).catch(() => undefined);
      await worker.terminate().catch(() => undefined);
    }
    fs.rmSync(logRoot, { recursive: true, force: true });
  }
}

async function run() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await runAttempt();
      return;
    } catch (error) {
      if (!(error instanceof HourBoundaryRetryError) || attempt > 0) throw error;
      console.log('↻ hour boundary crossed; retrying scheduler regression with a fresh current shard');
    }
  }
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => app?.exit(process.exitCode || 0));
