import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { app } = require('electron');

function loadBuiltStorage() {
  const distDir = path.resolve('dist-electron/main');
  const file = fs.readdirSync(distDir)
    .filter((name) => /^storage-.+\.js$/.test(name) && name !== 'storage-worker.js')
    .sort((left, right) => fs.statSync(path.join(distDir, right)).mtimeMs - fs.statSync(path.join(distDir, left)).mtimeMs)[0];
  if (!file) throw new Error('built storage module not found; run vite build first');
  return require(path.join(distDir, file));
}

function measure(fn, calls) {
  const startedAt = performance.now();
  for (let index = 0; index < calls; index++) fn();
  return performance.now() - startedAt;
}

async function main() {
  process.env.MQTTMOUNTAIN_STORAGE_WORKER = '0';
  const storage = loadBuiltStorage();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttmountain-diagnostics-performance-'));
  try {
    storage.initStorage(root);
    const now = Date.now();
    for (let connection = 0; connection < 4; connection++) {
      storage.enqueueMessage(`connection-${connection}`, 'topic/test', `payload-${connection}`, now);
    }
    storage.flushStorage();
    const calls = 2_000;
    const fullDiagnosticsMs = measure(() => storage.getStorageDiagnostics(), calls);
    const pendingCountMs = measure(() => storage.getPendingStorageEntryCount(), calls);
    if (pendingCountMs * 20 >= fullDiagnosticsMs) {
      throw new Error(`O(1) pending count was not at least 20x faster: full=${fullDiagnosticsMs}ms pending=${pendingCountMs}ms`);
    }
    console.log(JSON.stringify({
      calls,
      openDbs: storage.getStorageDiagnostics().openLogDbs,
      beforeFullDiagnosticsMs: Number(fullDiagnosticsMs.toFixed(3)),
      afterPendingCountMs: Number(pendingCountMs.toFixed(3)),
      speedup: Number((fullDiagnosticsMs / Math.max(0.001, pendingCountMs)).toFixed(1))
    }, null, 2));
    await storage.shutdownStorageAsync();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.MQTTMOUNTAIN_STORAGE_WORKER;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => app?.exit(process.exitCode || 0));
