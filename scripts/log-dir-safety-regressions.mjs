import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { app } = require('electron');
const ROOT_MARKER = '.mqttmountain-log-root.json';
const CONNECTION_MARKER = '.mqttmountain-connection.json';
const workerPath = path.resolve('dist-electron/main/log-dir-worker.js');
const autoDeleteWorkerPath = path.resolve('dist-electron/main/auto-delete-worker.js');

function marker(kind, connectionId) {
  return JSON.stringify({ owner: 'MQTTMountain', version: 1, kind, ...(connectionId ? { connectionId } : {}) });
}

function makeOwnedRoot(root, payload = 'history') {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, ROOT_MARKER), marker('log-root'));
  const connectionDir = path.join(root, 'connection-a');
  fs.mkdirSync(connectionDir, { recursive: true });
  fs.writeFileSync(path.join(connectionDir, CONNECTION_MARKER), marker('connection', 'connection-a'));
  fs.writeFileSync(path.join(connectionDir, '2026-09-04-10.db'), payload);
  return connectionDir;
}

function makeLargeOwnedRoot(root, connectionCount, filesPerConnection) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, ROOT_MARKER), marker('log-root'));
  for (let connection = 0; connection < connectionCount; connection++) {
    const name = `connection-${String(connection).padStart(3, '0')}`;
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, CONNECTION_MARKER), marker('connection', name));
    for (let file = 0; file < filesPerConnection; file++) {
      fs.writeFileSync(path.join(dir, `2026-08-01-${String(file).padStart(2, '0')}.db`), `${connection}:${file}`);
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

function runAutoDeleteWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(autoDeleteWorkerPath, { workerData });
    let settled = false;
    worker.once('message', (message) => {
      settled = true;
      if (message?.error) reject(new Error(message.error));
      else resolve(message);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`auto-delete worker exited without result (${code})`));
    });
  });
}

async function main() {
  if (!fs.existsSync(workerPath)) throw new Error('run `npx vite build` before this regression');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttmountain-logdir-regression-'));
  try {
    const deleteRoot = path.join(tempRoot, 'delete-source');
    const deleteConnection = makeOwnedRoot(deleteRoot);
    const foreignDir = path.join(deleteRoot, 'personal-project');
    fs.mkdirSync(foreignDir);
    fs.writeFileSync(path.join(foreignDir, 'important.txt'), 'keep-me');
    fs.writeFileSync(path.join(deleteRoot, 'personal.txt'), 'keep-root-file');
    const deleted = await runWorker({ operation: 'delete', sourceDir: deleteRoot });
    if (deleted.files !== 1) throw new Error(`expected one owned file deletion, got ${deleted.files}`);
    if (!fs.existsSync(path.join(foreignDir, 'important.txt')) || !fs.existsSync(path.join(deleteRoot, 'personal.txt'))) {
      throw new Error('delete operation removed foreign data');
    }
    if (fs.existsSync(path.join(deleteConnection, '2026-09-04-10.db'))) throw new Error('owned history file was not deleted');
    console.log('✓ delete removes only application-owned history files');

    const source = path.join(tempRoot, 'migration-source');
    makeOwnedRoot(source, 'source-history');
    const sourceForeign = path.join(source, 'photos');
    fs.mkdirSync(sourceForeign);
    fs.writeFileSync(path.join(sourceForeign, 'photo.bin'), 'foreign');
    const target = path.join(tempRoot, 'migration-target');
    fs.mkdirSync(target);
    const migrated = await runWorker({ operation: 'copy', sourceDir: source, targetDir: target });
    const migratedFile = path.join(target, 'connection-a', '2026-09-04-10.db');
    if (migrated.files !== 1 || fs.readFileSync(migratedFile, 'utf8') !== 'source-history') {
      throw new Error('owned history was not migrated intact');
    }
    if (!fs.existsSync(path.join(sourceForeign, 'photo.bin'))) throw new Error('migration removed foreign source data');
    if (!fs.existsSync(path.join(source, 'connection-a', '2026-09-04-10.db'))) throw new Error('copy phase removed source history before cutover');
    await runWorker({ operation: 'delete', sourceDir: source });
    if (fs.existsSync(path.join(source, 'connection-a', '2026-09-04-10.db'))) throw new Error('cleanup phase did not retire source history');
    console.log('✓ migration copy preserves source until explicit post-cutover cleanup');

    const collisionSource = path.join(tempRoot, 'collision-source');
    makeOwnedRoot(collisionSource, 'left');
    const collisionTarget = path.join(tempRoot, 'collision-target');
    makeOwnedRoot(collisionTarget, 'right');
    let collisionRejected = false;
    try {
      await runWorker({ operation: 'copy', sourceDir: collisionSource, targetDir: collisionTarget });
    } catch {
      collisionRejected = true;
    }
    if (!collisionRejected) throw new Error('different target history was overwritten');
    if (fs.readFileSync(path.join(collisionSource, 'connection-a', '2026-09-04-10.db'), 'utf8') !== 'left') {
      throw new Error('collision failure removed source data');
    }
    console.log('✓ migration rejects conflicting targets without deleting source');

    const interruptedRoot = path.join(tempRoot, 'interrupted-adoption');
    fs.mkdirSync(interruptedRoot);
    fs.writeFileSync(path.join(interruptedRoot, ROOT_MARKER), marker('log-root'));
    const legacyDir = path.join(interruptedRoot, 'legacy-connection');
    fs.mkdirSync(legacyDir);
    fs.writeFileSync(path.join(legacyDir, '2026-09-04-10.db'), 'legacy-history');
    const recoveredTarget = path.join(tempRoot, 'recovered-target');
    fs.mkdirSync(recoveredTarget);
    await runWorker({ operation: 'copy', sourceDir: interruptedRoot, targetDir: recoveredTarget });
    if (!fs.existsSync(path.join(legacyDir, CONNECTION_MARKER))) throw new Error('interrupted legacy adoption did not repair connection marker');
    if (fs.readFileSync(path.join(recoveredTarget, 'legacy-connection', '2026-09-04-10.db'), 'utf8') !== 'legacy-history') {
      throw new Error('recovered legacy history was not copied');
    }
    console.log('✓ interrupted root-marker adoption is idempotently repaired');

    const largeSource = path.join(tempRoot, 'large-source');
    const largeTarget = path.join(tempRoot, 'large-target');
    const largeConnections = 32;
    const filesPerConnection = 8;
    makeLargeOwnedRoot(largeSource, largeConnections, filesPerConnection);
    fs.writeFileSync(path.join(largeSource, 'foreign.txt'), 'keep-root-data');
    fs.mkdirSync(largeTarget);
    const largeCopied = await runWorker({ operation: 'copy', sourceDir: largeSource, targetDir: largeTarget });
    const expectedLargeFiles = largeConnections * filesPerConnection;
    if (largeCopied.files !== expectedLargeFiles) {
      throw new Error(`large copy expected ${expectedLargeFiles} files, got ${largeCopied.files}`);
    }
    if (!fs.existsSync(path.join(largeTarget, 'connection-031', CONNECTION_MARKER))
      || fs.readFileSync(path.join(largeTarget, 'connection-031', '2026-08-01-07.db'), 'utf8') !== '31:7') {
      throw new Error('large copy did not preserve the last connection/file');
    }
    const largeDeleted = await runWorker({ operation: 'delete', sourceDir: largeSource });
    if (largeDeleted.files !== expectedLargeFiles || !fs.existsSync(path.join(largeSource, 'foreign.txt'))) {
      throw new Error('large delete count or foreign-file preservation failed');
    }
    console.log('✓ synthetic large root copy/delete preserves ownership boundaries');

    const autoDeleteRoot = path.join(tempRoot, 'auto-delete-large');
    makeLargeOwnedRoot(autoDeleteRoot, 40, 8);
    fs.writeFileSync(path.join(autoDeleteRoot, 'foreign.txt'), 'keep-auto-delete-root-data');
    const autoDeleted = await runAutoDeleteWorker({
      logRoot: autoDeleteRoot,
      cutoff: Date.UTC(2026, 8, 1)
    });
    if (autoDeleted.removed !== 320 || autoDeleted.failed !== 0) {
      throw new Error(`large auto-delete expected 320 removals, got ${JSON.stringify(autoDeleted)}`);
    }
    if (!fs.existsSync(path.join(autoDeleteRoot, 'foreign.txt'))
      || !fs.existsSync(path.join(autoDeleteRoot, 'connection-000', CONNECTION_MARKER))) {
      throw new Error('auto-delete crossed ownership boundary or removed connection marker');
    }
    console.log('✓ synthetic large auto-delete reuses shard ranges and preserves markers');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => app?.exit(process.exitCode || 0));
