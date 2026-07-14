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
    worker.once('message', (message) => {
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
  const workerPath = path.resolve('dist-electron/main/storage-worker.js');
  const expectedDb = path.join(logRoot, 'fixture', '2026-07-14-09.db');
  const worker = new Worker(workerPath, { workerData: { logRoot } });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('storage shard worker timed out')), 15_000);
      worker.on('message', (message) => {
        if (message?.id === 1) {
          if (!message.ok) {
            clearTimeout(timer);
            reject(new Error(message.error || 'storage batch failed'));
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
        payload: [{ connectionId: 'fixture', topic: 'a/b', payload: '{"ok":true}', tsMs }]
      });
    });

    if (!fs.existsSync(expectedDb)) throw new Error(`hour shard was not created: ${expectedDb}`);
    const db = new Database(expectedDb, { readonly: true });
    try {
      const row = db.prepare('SELECT COALESCE(SUM(count), 0) AS count FROM buckets').get();
      if (Number(row?.count) !== 1) throw new Error(`expected 1 committed message, got ${row?.count}`);
    } finally {
      db.close();
    }
    fs.copyFileSync(expectedDb, path.join(logRoot, 'fixture', '2026-07-14.db'));
    const rows = await queryHistory(logRoot, {
      connectionId: 'fixture',
      startTime: tsMs - 1_000,
      endTime: tsMs + 1_000,
      order: 'asc',
      limit: 10
    });
    if (!Array.isArray(rows) || rows.length !== 2) {
      throw new Error(`expected daily and hourly files to both be queried, got ${Array.isArray(rows) ? rows.length : 'invalid result'}`);
    }
    console.log('✓ storage-hour-shard durable commit');
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
