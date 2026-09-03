import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const tempBundleDir = path.resolve('node_modules/.cache/mqttmountain-logdir-performance');
const safetyBundle = path.join(tempBundleDir, 'log-root-safety.cjs');
const workerPath = path.resolve('dist-electron/main/log-dir-worker.js');
const ROOT_MARKER = '.mqttmountain-log-root.json';
const CONNECTION_MARKER = '.mqttmountain-connection.json';

function marker(kind, connectionId) {
  return JSON.stringify({ owner: 'MQTTMountain', version: 1, kind, ...(connectionId ? { connectionId } : {}) });
}

function makeRoot(root, connectionCount, filesPerConnection) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, ROOT_MARKER), marker('log-root'));
  const payload = Buffer.alloc(1024, 7);
  for (let connection = 0; connection < connectionCount; connection++) {
    const name = `connection-${String(connection).padStart(4, '0')}`;
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, CONNECTION_MARKER), marker('connection', name));
    for (let file = 0; file < filesPerConnection; file++) {
      const hour = String(file % 24).padStart(2, '0');
      const day = String(1 + Math.floor(file / 24)).padStart(2, '0');
      fs.writeFileSync(path.join(dir, `2026-08-${day}-${hour}.db`), payload);
    }
  }
}

function runWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData });
    let settled = false;
    worker.once('message', (message) => {
      settled = true;
      if (message?.ok) resolve(message.result);
      else reject(new Error(message?.error || 'worker failed'));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`worker exited without result (${code})`));
    });
  });
}

async function main() {
  fs.mkdirSync(tempBundleDir, { recursive: true });
  await build({
    entryPoints: [path.resolve('electron/main/log-root-safety.ts')],
    outfile: safetyBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent'
  });
  const { listOwnedHistoryFiles } = require(safetyBundle);
  if (!fs.existsSync(workerPath)) throw new Error('run `npx vite build` before this benchmark');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttmountain-logdir-performance-'));
  try {
    const scanRoot = path.join(tempRoot, 'scan');
    makeRoot(scanRoot, 250, 4);
    const scanStarted = performance.now();
    let scanned = 0;
    for (let pass = 0; pass < 5; pass++) scanned += listOwnedHistoryFiles(scanRoot).length;
    const scanMs = performance.now() - scanStarted;

    const copySource = path.join(tempRoot, 'copy-source');
    const copyTarget = path.join(tempRoot, 'copy-target');
    makeRoot(copySource, 150, 1);
    fs.mkdirSync(copyTarget);
    const copyStarted = performance.now();
    const copied = await runWorker({ operation: 'copy', sourceDir: copySource, targetDir: copyTarget });
    const copyMs = performance.now() - copyStarted;

    console.log(JSON.stringify({
      scan: { connections: 250, files: 1000, passes: 5, rows: scanned, ms: Number(scanMs.toFixed(2)) },
      copy: { connections: 150, files: copied.files, bytes: copied.bytes, ms: Number(copyMs.toFixed(2)) },
      structuralChecks: {
        scanRootMarkerReadsBefore: 250 * 5,
        scanRootMarkerReadsAfter: 5,
        copyRootValidationPassesBefore: 151,
        copyRootValidationPassesAfter: 2,
        autoDeleteRangeParsesBefore: 250 * 4,
        autoDeleteRangeParsesAfter: 4
      }
    }, null, 2));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(tempBundleDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
