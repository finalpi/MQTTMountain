import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { app } = require('electron');

function loadBuiltStorage() {
  const distDir = path.resolve('dist-electron/main');
  const file = fs.readdirSync(distDir)
    .filter((name) => /^storage-.+\.js$/.test(name))
    .sort((left, right) => fs.statSync(path.join(distDir, right)).mtimeMs - fs.statSync(path.join(distDir, left)).mtimeMs)[0];
  if (!file) throw new Error('built storage module not found; run vite build first');
  return require(path.join(distDir, file));
}

async function run() {
  const storage = loadBuiltStorage();
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttmountain-watermark-race-'));
  const connectionId = 'fixture';
  const now = Date.now();
  const payloadBody = 'x'.repeat(2_048);

  storage.initStorage(logRoot);
  try {
    for (let index = 0; index < 300; index++) {
      storage.enqueueMessage(connectionId, `fixture/seed/${index % 10}`, `${index}:${payloadBody}`, now + index);
    }
    const targetSequence = Number(storage.getStorageDiagnostics().workerAcceptedSequence);
    const barrier = storage.flushStorageAsync();

    // These messages arrive after the barrier was created. They deliberately
    // keep the worker busy, but must not delay durability of the seed watermark.
    for (let index = 0; index < 12_000; index++) {
      storage.enqueueMessage(connectionId, `fixture/later/${index % 100}`, `${index}:${payloadBody}`, now + 1_000 + index);
    }

    await Promise.race([
      barrier,
      new Promise((_, reject) => setTimeout(() => reject(new Error(
        `watermark barrier timed out: ${JSON.stringify(storage.getStorageDiagnostics())}`
      )), 8_000))
    ]);

    const diagnostics = storage.getStorageDiagnostics();
    const committedSequence = Number(diagnostics.workerCommittedSequence);
    const acceptedSequence = Number(diagnostics.workerAcceptedSequence);
    if (committedSequence < targetSequence) {
      throw new Error(`barrier resolved before its watermark: target=${targetSequence}, committed=${committedSequence}`);
    }
    if (acceptedSequence <= targetSequence) {
      throw new Error(`fixture did not enqueue post-watermark writes: target=${targetSequence}, accepted=${acceptedSequence}`);
    }
    if (committedSequence >= acceptedSequence) {
      throw new Error(`fixture fully drained before the watermark assertion: committed=${committedSequence}, accepted=${acceptedSequence}`);
    }
    if (Number(diagnostics.workerWatermarkTimeouts) !== 0) {
      throw new Error(`watermark wait unexpectedly timed out: ${JSON.stringify(diagnostics)}`);
    }
    if (Number(diagnostics.workerOldestBatchAgeMs) >= 8_000) {
      throw new Error(`oldest in-flight batch age was not refreshed: ${diagnostics.workerOldestBatchAgeMs}`);
    }
    console.log('✓ durable watermark resolves while newer MQTT writes remain active');
    console.log('✓ watermark diagnostics report committed and accepted sequences');
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
  .finally(() => app?.exit(process.exitCode || 0));
