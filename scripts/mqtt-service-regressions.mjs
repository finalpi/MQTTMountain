import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const tempDir = path.resolve('node_modules/.cache/mqttmountain-regressions');
const bundlePath = path.join(tempDir, 'mqtt-service.cjs');

function packetLength(buffer) {
  if (buffer.length < 2) return null;
  let multiplier = 1;
  let remaining = 0;
  let index = 1;
  for (;;) {
    if (index >= buffer.length) return null;
    const digit = buffer[index++];
    remaining += (digit & 127) * multiplier;
    if ((digit & 128) === 0) break;
    multiplier *= 128;
  }
  return { headerBytes: index, total: index + remaining };
}

async function main() {
  fs.mkdirSync(tempDir, { recursive: true });
  await build({
    entryPoints: [path.resolve('electron/main/mqtt-service.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron', 'better-sqlite3'],
    logLevel: 'silent'
  });
  process.env.MQTTMOUNTAIN_OPERATION_TIMEOUT_MS = '120';
  const { MqttService } = require(bundlePath);

  const server = net.createServer((socket) => {
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const length = packetLength(buffered);
        if (!length || buffered.length < length.total) break;
        const packet = buffered.subarray(0, length.total);
        buffered = buffered.subarray(length.total);
        const type = packet[0] >> 4;
        if (type === 1) socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
        else if (type === 8) {
          const idOffset = length.headerBytes;
          socket.write(Buffer.from([0x90, 0x03, packet[idOffset], packet[idOffset + 1], 0x80]));
        } else if (type === 12) socket.write(Buffer.from([0xd0, 0x00]));
        // QoS 1 PUBLISH is deliberately left without PUBACK to exercise timeout.
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock broker did not expose a port');

  const service = new MqttService(() => null);
  try {
    const connected = await service.connect({
      connectionId: 'fixture',
      protocol: 'mqtt://',
      host: '127.0.0.1',
      port: address.port,
      path: '',
      clientId: 'fixture-client',
      disabledTopics: []
    });
    if (!connected.success) throw new Error(`connect failed: ${connected.message}`);

    const subscribed = await service.subscribe('fixture', 'denied/topic', 1);
    if (subscribed.success) {
        throw new Error(`SUBACK 128 was not surfaced: ${JSON.stringify(subscribed)}`);
    }
    console.log('✓ SUBACK qos=128 is reported as a rejected subscription');

    const startedAt = Date.now();
    const published = await service.publish('fixture', { topic: 'no/puback', payload: 'value', qos: 1, retain: false });
    const elapsed = Date.now() - startedAt;
    if (published.success || !published.message?.includes('超时') || elapsed < 100 || elapsed > 2_000) {
      throw new Error(`publish timeout failed: ${JSON.stringify({ published, elapsed })}`);
    }
    console.log('✓ QoS publish without PUBACK resolves with bounded timeout');
  } finally {
    service.shutdown();
    await new Promise((resolve) => server.close(resolve));
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });
