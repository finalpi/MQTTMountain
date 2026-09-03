import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { app } = require('electron');
const Database = require('better-sqlite3');
const workerPath = path.resolve('dist-electron/main/storage-worker.js');

function shardKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}`;
}

function unpack(blob) {
  if (blob.subarray(0, 4).toString() !== 'MMZ1') return blob;
  const raw = zlib.inflateRawSync(blob.subarray(8));
  if (raw.length !== blob.readUInt32LE(4)) throw new Error('bad decompressed length');
  return raw;
}

function payloads(blob) {
  const raw = unpack(blob);
  const count = raw.readUInt32LE(0);
  const out = [];
  let offset = 4;
  for (let index = 0; index < count; index++) {
    offset += 2;
    const size = raw.readUInt32LE(offset);
    offset += 4;
    out.push(raw.subarray(offset, offset + size));
    offset += size;
  }
  if (offset !== raw.length) throw new Error('bucket contains trailing bytes');
  return out;
}

function startStorageWorker(logRoot) {
  const worker = new Worker(workerPath, { workerData: { logRoot } });
  let id = 0;
  const pending = new Map();
  worker.on('message', (message) => {
    if (message?.id == null) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error || 'storage worker error'));
  });
  const call = (command, payload, timeoutMs = 10_000) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    worker.postMessage({ id: requestId, command, payload });
  });
  return { worker, call };
}

async function stopStorageWorker(handle) {
  try { await handle.call('shutdown', undefined, 10_000); } finally { await handle.worker.terminate(); }
}

async function main() {
  if (!fs.existsSync(workerPath)) throw new Error('run `npx vite build` before this regression');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttmountain-corruption-regression-'));
  const bundleDir = path.resolve('node_modules/.cache/mqttmountain-storage-disk-regression');
  const connectionId = 'fixture';
  // Keep every fixture entry in one shard even when this regression starts at
  // xx:59:59 and the worker RPC crosses the wall-clock hour boundary.
  const fixtureHour = new Date();
  fixtureHour.setMinutes(10, 0, 0);
  const base = fixtureHour.getTime();
  const dbPath = path.join(root, connectionId, `${shardKey(base)}.db`);
  try {
    let handle = startStorageWorker(root);
    await handle.call('enqueueBatch', [
      { connectionId, topic: 'metadata/test', payload: 'old-a', tsMs: base + 10 },
      { connectionId, topic: 'metadata/test', payload: 'old-b', tsMs: base + 20 }
    ]);
    await stopStorageWorker(handle);

    let db = new Database(dbPath);
    db.prepare("UPDATE buckets SET bytes = bytes + 7 WHERE topic = 'metadata/test'").run();
    db.close();

    handle = startStorageWorker(root);
    await handle.call('enqueueBatch', [
      { connectionId, topic: 'metadata/test', payload: 'new-c', tsMs: base + 30 }
    ]);
    await stopStorageWorker(handle);

    db = new Database(dbPath, { readonly: true });
    let row = db.prepare("SELECT blob, count, bytes FROM buckets WHERE topic = 'metadata/test'").get();
    const metadataPayloads = payloads(row.blob).map((value) => value.toString());
    const metadataBackups = Number(db.prepare("SELECT COUNT(*) AS count FROM bucket_blob_backups WHERE topic = 'metadata/test'").get().count);
    db.close();
    if (row.count !== 3 || row.bytes !== row.blob.length || metadataPayloads.join(',') !== 'old-a,old-b,new-c' || metadataBackups < 1) {
      throw new Error(`metadata repair corrupted messages: ${JSON.stringify({ count: row.count, metadataPayloads, metadataBackups })}`);
    }
    console.log('✓ bytes metadata mismatch preserves old and new messages with backup');

    db = new Database(dbPath);
    const broken = Buffer.alloc(11);
    broken.write('MMZ1', 0);
    broken.writeUInt32LE(128, 4);
    broken.set([1, 2, 3], 8);
    db.prepare('INSERT OR REPLACE INTO buckets(bucket_ts, topic, blob, count, bytes) VALUES(?,?,?,?,?)')
      .run(Math.floor(base / 1000) + 1, 'compressed/broken', broken, 1, broken.length);
    db.close();

    handle = startStorageWorker(root);
    await handle.call('enqueueBatch', [
      { connectionId, topic: 'compressed/broken', payload: 'replacement', tsMs: base + 1_100 },
      {
        connectionId,
        topic: 'binary/raw',
        payload: '\ufffd\u0000\ufffd',
        payloadBytes: Buffer.from([0xff, 0x00, 0xfe]),
        payloadSize: 3,
        payloadEncoding: 'invalid-utf8',
        tsMs: base + 2_100
      }
    ]);
    await stopStorageWorker(handle);

    db = new Database(dbPath, { readonly: true });
    row = db.prepare("SELECT blob, count FROM buckets WHERE topic = 'compressed/broken'").get();
    const quarantined = Number(db.prepare("SELECT COUNT(*) AS count FROM bucket_blob_backups WHERE topic = 'compressed/broken'").get().count);
    const binaryRow = db.prepare("SELECT blob FROM buckets WHERE topic = 'binary/raw'").get();
    db.close();
    if (row.count !== 1 || payloads(row.blob)[0].toString() !== 'replacement' || quarantined !== 1) {
      throw new Error('structurally corrupt compressed bucket was not quarantined');
    }
    if (payloads(binaryRow.blob)[0].toString('base64') !== '/wD+') throw new Error('invalid UTF-8 bytes were not preserved');
    console.log('✓ corrupt compressed bucket is quarantined without blocking durable ACK');
    console.log('✓ invalid UTF-8 payload bytes remain lossless in history storage');

    const bundlePath = path.join(bundleDir, 'storage.cjs');
    fs.mkdirSync(bundleDir, { recursive: true });
    process.env.MQTTMOUNTAIN_STORAGE_WORKER = '0';
    process.env.MQTTMOUNTAIN_DISK_CRITICAL_BYTES = String(Number.MAX_SAFE_INTEGER);
    await build({
      entryPoints: [path.resolve('electron/main/storage.ts')],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['better-sqlite3'],
      logLevel: 'silent'
    });
    const localStorage = require(bundlePath);
    const diskRoot = path.join(root, 'critical-disk');
    let diskEvent;
    localStorage.setStorageDiskPressureListener((event) => { diskEvent = event; });
    localStorage.initStorage(diskRoot);
    localStorage.enqueueMessage('fixture', 'disk/test', 'still-visible-in-mqtt-ui', base + 3_100);
    const diskDiagnostics = localStorage.getStorageDiagnostics();
    await localStorage.shutdownStorageAsync();
    fs.rmSync(bundleDir, { recursive: true, force: true });
    delete process.env.MQTTMOUNTAIN_STORAGE_WORKER;
    delete process.env.MQTTMOUNTAIN_DISK_CRITICAL_BYTES;
    if (diskEvent?.level !== 'critical' || diskEvent.historyWritesPaused !== true || diskDiagnostics.diskSkippedEntries !== 1) {
      throw new Error(`critical disk guard did not pause history only: ${JSON.stringify({ diskEvent, diskDiagnostics })}`);
    }
    if (fs.existsSync(path.join(diskRoot, 'fixture'))) throw new Error('critical disk guard still created a history shard');
    console.log('✓ critical disk space pauses history writes with an observable event');
  } finally {
    try { fs.rmSync(bundleDir, { recursive: true, force: true }); } catch {}
    delete process.env.MQTTMOUNTAIN_STORAGE_WORKER;
    delete process.env.MQTTMOUNTAIN_DISK_CRITICAL_BYTES;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => app?.exit(process.exitCode || 0));
