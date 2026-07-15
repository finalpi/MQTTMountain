import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { app } = require('electron');
const Database = require('better-sqlite3');

function loadBuiltStorage() {
  const distDir = path.resolve('dist-electron/main');
  const file = fs.readdirSync(distDir).find((name) => /^storage-.+\.js$/.test(name));
  if (!file) throw new Error('built storage module not found; run vite build first');
  return require(path.join(distDir, file));
}

async function run() {
  const storage = loadBuiltStorage();
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttmountain-maintenance-race-'));
  const connectionId = 'fixture';
  const tsMs = new Date(2026, 6, 15, 9, 34, 0).getTime();

  storage.initStorage(logRoot);
  try {
    for (let i = 0; i < 100; i++) {
      storage.enqueueMessage(connectionId, 'fixture/before', `before-${i}`, tsMs + i);
    }

    const maintenance = storage.clearLogsWithoutConnectionsAsync([connectionId]);
    for (let i = 0; i < 50; i++) {
      storage.enqueueMessage(connectionId, 'fixture/during', `during-${i}`, tsMs + 1_000 + i);
    }

    await Promise.race([
      maintenance,
      new Promise((_, reject) => setTimeout(() => reject(new Error(
        `maintenance timed out: ${JSON.stringify(storage.getStorageDiagnostics())}`
      )), 15_000))
    ]);
    await storage.flushStorageAsync();

    const dbPath = path.join(logRoot, connectionId, '2026-07-15-09.db');
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare('SELECT COALESCE(SUM(count), 0) AS count FROM buckets').get();
      if (Number(row.count) !== 150) {
        throw new Error(`expected 150 durable messages after maintenance, got ${row.count}`);
      }
    } finally {
      db.close();
    }
    console.log('✓ maintenance drains existing writes and durably resumes deferred writes');
  } finally {
    await storage.shutdownStorageAsync().catch(() => undefined);
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
