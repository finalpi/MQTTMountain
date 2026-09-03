import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const tempDir = path.resolve('node_modules/.cache/mqttmountain-renderer-regressions');
const bundlePath = path.join(tempDir, 'renderer-regressions.cjs');

async function main() {
  fs.mkdirSync(tempDir, { recursive: true });
  await build({
    entryPoints: [path.resolve('scripts/renderer-regressions-entry.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent'
  });
  require(bundlePath);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });
