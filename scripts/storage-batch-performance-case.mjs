import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

async function main() {
  const storage = loadBuiltStorage();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttmountain-batch-performance-'));
  const messages = 300;
  const payload = 'x'.repeat(1000);
  try {
    storage.initStorage(root);
    const startedAt = Date.now();
    for (let index = 0; index < messages; index++) {
      storage.enqueueMessage('fixture', `topic/${index % 10}`, `${index}:${payload}`, startedAt + index * 10);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await storage.flushStorageAsync();
    const diagnostics = storage.getStorageDiagnostics();
    console.log(JSON.stringify({
      batchMs: Number(process.env.MQTTMOUNTAIN_STORAGE_BATCH_MS),
      messages,
      ackedBatches: diagnostics.workerAckedBatches,
      averageEntries: diagnostics.workerAvgAckedBatchEntries,
      elapsedMs: Date.now() - startedAt
    }));
    await storage.shutdownStorageAsync();
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
