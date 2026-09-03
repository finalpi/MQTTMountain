import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { app } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttmountain-diagnostics-benchmark-'));
const bundleDir = path.resolve('node_modules/.cache/mqttmountain-diagnostics-benchmark');
const bundlePath = path.join(bundleDir, 'diagnostics.cjs');
const baselinePath = path.join(root, 'baseline', 'main.log');
const optimizedPath = path.join(root, 'optimized', 'main.log');
const calls = 5_000;

function baselineWrite(label, value) {
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  if (fs.existsSync(baselinePath)) fs.statSync(baselinePath).size;
  fs.appendFileSync(baselinePath, `${new Date().toISOString()} ${label} ${JSON.stringify(value)}\n`, 'utf8');
}

try {
  fs.mkdirSync(bundleDir, { recursive: true });
  await build({
    entryPoints: [path.resolve('electron/main/diagnostics.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    logLevel: 'silent'
  });
  process.env.MQTTMOUNTAIN_DIAGNOSTIC_LOG_PATH = optimizedPath;
  const diagnostics = require(bundlePath);

  let startedAt = performance.now();
  for (let index = 0; index < calls; index++) baselineWrite('[benchmark]', { index, count: index % 100 });
  const baselineMs = performance.now() - startedAt;

  startedAt = performance.now();
  for (let index = 0; index < calls; index++) diagnostics.writeDiagnosticLog('[benchmark]', { index, count: index % 100 });
  const optimizedMs = performance.now() - startedAt;
  diagnostics.closeDiagnosticLog();

  const baselineLines = fs.readFileSync(baselinePath, 'utf8').trim().split('\n').length;
  const optimizedLines = fs.readFileSync(optimizedPath, 'utf8').trim().split('\n').length;
  if (baselineLines !== calls || optimizedLines !== calls) throw new Error(`diagnostic line loss: ${baselineLines}/${optimizedLines}`);
  if (optimizedMs * 2 >= baselineMs) throw new Error(`persistent diagnostic writer was less than 2x faster: ${baselineMs}ms -> ${optimizedMs}ms`);
  console.log(JSON.stringify({
    calls,
    beforeAppendFileMs: Number(baselineMs.toFixed(3)),
    afterPersistentFdMs: Number(optimizedMs.toFixed(3)),
    speedup: Number((baselineMs / optimizedMs).toFixed(1)),
    linesPreserved: optimizedLines
  }, null, 2));
} finally {
  delete process.env.MQTTMOUNTAIN_DIAGNOSTIC_LOG_PATH;
  try { fs.rmSync(bundleDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  app?.exit(process.exitCode || 0);
}
