import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const execFileAsync = promisify(execFile);
const casePath = path.resolve('scripts/storage-batch-performance-case.mjs');

async function runCase(batchMs) {
  const { stdout } = await execFileAsync(electronPath, [casePath], {
    cwd: process.cwd(),
    env: { ...process.env, MQTTMOUNTAIN_STORAGE_BATCH_MS: String(batchMs) },
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024
  });
  const line = stdout.trim().split(/\r?\n/u).findLast((value) => value.trim().startsWith('{'));
  if (!line) throw new Error(`batch benchmark returned no JSON: ${stdout}`);
  return JSON.parse(line);
}

const before = await runCase(50);
const after = await runCase(500);
assert.equal(before.messages, after.messages);
assert.ok(after.ackedBatches <= before.ackedBatches * 0.65, `durable batch count did not drop enough: ${before.ackedBatches} -> ${after.ackedBatches}`);
assert.ok(after.averageEntries > before.averageEntries, `average batch size did not improve: ${before.averageEntries} -> ${after.averageEntries}`);
console.log(JSON.stringify({
  before,
  after,
  durableBatchReductionPercent: Number(((1 - after.ackedBatches / before.ackedBatches) * 100).toFixed(1))
}, null, 2));
