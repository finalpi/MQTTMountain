import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { app } = require('electron');
const Database = require('better-sqlite3');
const JSZip = require('jszip');
const workerPath = path.resolve('dist-electron/main/history-export-worker.js');

function shardKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}`;
}

function bucket(payload, offsetMs) {
  const bytes = Buffer.from(payload);
  const value = Buffer.alloc(10 + bytes.length);
  value.writeUInt32LE(1, 0);
  value.writeUInt16LE(offsetMs, 4);
  value.writeUInt32LE(bytes.length, 6);
  bytes.copy(value, 10);
  return value;
}

function runExport(logRoot, targetPath) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: {
        req: { format: 'zip', query: {}, conditions: [] },
        targetPath,
        logRoot
      }
    });
    let settled = false;
    worker.on('message', (message) => {
      if (message?.type === 'done') {
        settled = true;
        resolve(message.result);
      } else if (message?.type === 'error') {
        settled = true;
        reject(new Error(message.error || 'export failed'));
      }
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`export worker exited without result (${code})`));
    });
  });
}

async function main() {
  if (!fs.existsSync(workerPath)) throw new Error('run `npx vite build` before this regression');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttmountain-export-regression-'));
  try {
    const connectionDir = path.join(root, 'fixture');
    fs.mkdirSync(connectionDir);
    const base = Math.floor(Date.now() / 1000) * 1000;
    const db = new Database(path.join(connectionDir, `${shardKey(base)}.db`));
    db.exec('CREATE TABLE buckets(bucket_ts INTEGER NOT NULL, topic TEXT NOT NULL, blob BLOB NOT NULL, count INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(bucket_ts, topic)) WITHOUT ROWID');
    const insert = db.prepare('INSERT INTO buckets(bucket_ts, topic, blob, count, bytes) VALUES(?,?,?,?,?)');
    const topics = ['A', 'a', 'CON', `${'very-long-topic-'.repeat(30)}`, ...Array.from({ length: 76 }, (_, index) => `group/${index}`)];
    for (let index = 0; index < topics.length; index++) {
      const value = bucket(`payload-${index}`, index % 1000);
      insert.run(Math.floor(base / 1000), topics[index], value, 1, value.length);
    }
    db.close();

    const targetPath = path.join(root, 'result.zip');
    const result = await runExport(root, targetPath);
    if (result.totalRows !== topics.length) throw new Error(`expected ${topics.length} rows, got ${result.totalRows}`);
    const zip = await JSZip.loadAsync(fs.readFileSync(targetPath));
    const entries = Object.values(zip.files).filter((entry) => !entry.dir);
    if (entries.length !== topics.length) throw new Error(`expected ${topics.length} topic files, got ${entries.length}`);
    const bodies = await Promise.all(entries.map((entry) => entry.async('string')));
    for (let index = 0; index < topics.length; index++) {
      if (!bodies.some((body) => body.includes(`payload-${index}`))) throw new Error(`missing exported payload-${index}`);
    }
    if (entries.some((entry) => path.basename(entry.name).length > 140)) throw new Error('export filename was not bounded');
    console.log('✓ ZIP export bounds open streams and preserves case-distinct/reserved/long topics');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => app?.exit(process.exitCode || 0));
