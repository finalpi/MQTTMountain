import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { app } = require('electron');
const Database = require('better-sqlite3');

function percentile(values, ratio) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * ratio)];
}

function runCase(root, name, checkpointPages, sizeLimitBytes) {
  const dbPath = path.join(root, `${name}.db`);
  const db = new Database(dbPath);
  db.pragma('page_size = 1024');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma(`wal_autocheckpoint = ${checkpointPages}`);
  db.pragma(`journal_size_limit = ${sizeLimitBytes}`);
  db.exec('CREATE TABLE payloads(id INTEGER PRIMARY KEY, payload BLOB NOT NULL)');
  const insert = db.prepare('INSERT INTO payloads(id, payload) VALUES (?, ?)');
  const writeBatch = db.transaction((start) => {
    for (let offset = 0; offset < 100; offset++) {
      const payload = Buffer.alloc(2048, (start + offset) % 251);
      insert.run(start + offset, payload);
    }
  });
  const transactionMs = [];
  const writeStartedAt = performance.now();
  for (let start = 0; start < 12_000; start += 100) {
    const beganAt = performance.now();
    writeBatch(start);
    transactionMs.push(performance.now() - beganAt);
  }
  const totalWriteMs = performance.now() - writeStartedAt;
  const walPath = `${dbPath}-wal`;
  const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
  const checkpointStartedAt = performance.now();
  db.pragma('wal_checkpoint(TRUNCATE)');
  const finalCheckpointMs = performance.now() - checkpointStartedAt;
  db.close();
  return {
    checkpointPages,
    sizeLimitBytes,
    walBytes,
    totalWriteMs: Number(totalWriteMs.toFixed(3)),
    transactionP95Ms: Number(percentile(transactionMs, 0.95).toFixed(3)),
    transactionP99Ms: Number(percentile(transactionMs, 0.99).toFixed(3)),
    transactionMaxMs: Number(Math.max(...transactionMs).toFixed(3)),
    finalCheckpointMs: Number(finalCheckpointMs.toFixed(3))
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttmountain-wal-performance-'));
try {
  // Manual trade-off probe only (not a CI "smaller is better" invariant).
  // Smaller thresholds bound WAL size, but repeated runs showed materially worse
  // transaction tail latency/write amplification, so production keeps 256 MiB.
  // Scale production's 256 MiB -> 64 MiB policy down by 64x so the benchmark
  // crosses both thresholds quickly while preserving the 4:1 relationship.
  const before = runCase(root, 'before', 4096, 4 * 1024 * 1024);
  const middle = runCase(root, 'middle', 2048, 2 * 1024 * 1024);
  const after = runCase(root, 'after', 1024, 1024 * 1024);
  if (after.walBytes > before.walBytes * 0.5) {
    throw new Error(`smaller checkpoint policy did not bound WAL size: ${before.walBytes} -> ${after.walBytes}`);
  }
  console.log(JSON.stringify({
    decision: 'retain the production 256 MiB policy; smaller WAL is not automatically faster',
    before,
    middle,
    after,
    walSizeReductionPercent: Number(((1 - after.walBytes / before.walBytes) * 100).toFixed(1))
  }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  app?.exit(process.exitCode || 0);
}
