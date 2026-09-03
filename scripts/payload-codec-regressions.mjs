import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const tempDir = path.resolve('node_modules/.cache/mqttmountain-payload-codec-regressions');
const bundlePath = path.join(tempDir, 'payload-codec.cjs');

try {
  fs.mkdirSync(tempDir, { recursive: true });
  await build({
    entryPoints: [path.resolve('electron/main/payload-codec.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent'
  });
  const { decodePayloadView } = require(bundlePath);
  const bomPayload = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"ok":true}')]);
  const decodedBom = decodePayloadView(bomPayload);
  assert.equal(decodedBom.encoding, 'utf8');
  assert.deepEqual(Buffer.from(decodedBom.text, 'utf8'), bomPayload, 'UTF-8 BOM must survive string-only storage path');

  const invalid = Buffer.from([0xff, 0x00, 0xfe]);
  const decodedInvalid = decodePayloadView(invalid);
  assert.equal(decodedInvalid.encoding, 'invalid-utf8');
  assert.equal(decodedInvalid.base64, invalid.toString('base64'));
  console.log('✓ valid UTF-8 BOM round-trips without payloadBytes');
  console.log('✓ invalid UTF-8 still retains raw base64');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
