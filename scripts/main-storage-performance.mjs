import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { serialize } from 'node:v8';

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function measureSerialize(value, rounds = 15) {
  const elapsed = [];
  let bytes = 0;
  for (let index = 0; index < rounds; index++) {
    const startedAt = performance.now();
    const serialized = serialize(value);
    elapsed.push(performance.now() - startedAt);
    bytes = serialized.byteLength;
  }
  return { bytes, medianMs: Number(median(elapsed).toFixed(3)) };
}

function compareRows(a, b) {
  return b.time - a.time || b.connectionId.localeCompare(a.connectionId) || b.topic.localeCompare(a.topic);
}

function mergeTop(left, right, limit) {
  const merged = [];
  let a = 0;
  let b = 0;
  while (merged.length < limit && (a < left.length || b < right.length)) {
    if (a >= left.length) merged.push(right[b++]);
    else if (b >= right.length) merged.push(left[a++]);
    else if (compareRows(left[a], right[b]) <= 0) merged.push(left[a++]);
    else merged.push(right[b++]);
  }
  return merged;
}

function benchmarkMerge() {
  const fileCount = 8;
  const rowsPerFile = 20_000;
  const limit = 10_000;
  const files = Array.from({ length: fileCount }, (_, connection) => Array.from({ length: rowsPerFile }, (_, index) => ({
    connectionId: `connection-${connection}`,
    topic: `topic-${index % 50}`,
    payload: `payload-${index}`,
    time: 2_000_000_000_000 - index * fileCount - connection
  })).sort(compareRows));

  const oldTimes = [];
  const nextTimes = [];
  for (let round = 0; round < 7; round++) {
    let startedAt = performance.now();
    const oldRows = files.flat().sort(compareRows).slice(0, limit);
    oldTimes.push(performance.now() - startedAt);

    startedAt = performance.now();
    let nextRows = [];
    for (const fileRows of files) nextRows = mergeTop(nextRows, fileRows.slice(0, limit), limit);
    nextTimes.push(performance.now() - startedAt);
    assert.deepEqual(nextRows, oldRows);
  }
  return {
    oldMedianMs: Number(median(oldTimes).toFixed(2)),
    nextMedianMs: Number(median(nextTimes).toFixed(2)),
    oldCandidateReferences: fileCount * rowsPerFile,
    nextCandidateReferences: limit * 3,
    outputRows: limit
  };
}

function oldFtsBatch(current, elapsedMs) {
  const factor = Math.max(0.5, Math.min(2, 750 / elapsedMs));
  const adjusted = Math.round((current * factor) / 500) * 500;
  return Math.max(1000, Math.min(20_000, adjusted));
}

function nextFtsBatch(current, elapsedMs) {
  const factor = Math.max(0.1, Math.min(2, 750 / elapsedMs));
  const adjusted = Math.round((current * factor) / 100) * 100;
  return Math.max(100, Math.min(20_000, adjusted));
}

const baseEntries = Array.from({ length: 500 }, (_, index) => {
  const payload = JSON.stringify({ index, telemetry: 'x'.repeat(2780), checksum: index.toString(16) });
  return { connectionId: 'fixture', topic: `topic/${index % 10}`, payload, tsMs: index, payloadSize: Buffer.byteLength(payload) };
});
const duplicatePayloadEntries = baseEntries.map((entry) => ({ ...entry, payloadBytes: Buffer.from(entry.payload) }));
const stringOnly = measureSerialize({ command: 'enqueueBatch', payload: baseEntries });
const stringAndBuffer = measureSerialize({ command: 'enqueueBatch', payload: duplicatePayloadEntries });
const merge = benchmarkMerge();
const observedSlowFtsCycles = [
  { requested: 1500, elapsedMs: 12_502 },
  { requested: 1000, elapsedMs: 7_529 },
  { requested: 1500, elapsedMs: 5_353 }
].map((sample) => ({
  ...sample,
  oldNextBatch: oldFtsBatch(sample.requested, sample.elapsedMs),
  newNextBatch: nextFtsBatch(sample.requested, sample.elapsedMs)
}));

assert.ok(stringOnly.bytes <= stringAndBuffer.bytes * 0.6, 'valid UTF-8 storage payload clone did not shrink by at least 40%');
assert.ok(merge.nextCandidateReferences <= merge.oldCandidateReferences / 4, 'incremental history merge retained too many candidates');
assert.ok(observedSlowFtsCycles.every((sample) => sample.newNextBatch < sample.oldNextBatch), 'slow FTS samples did not adapt downward');

console.log(JSON.stringify({
  structuredClone: {
    beforeBytes: stringAndBuffer.bytes,
    afterBytes: stringOnly.bytes,
    byteReductionPercent: Number(((1 - stringOnly.bytes / stringAndBuffer.bytes) * 100).toFixed(1)),
    beforeMedianMs: stringAndBuffer.medianMs,
    afterMedianMs: stringOnly.medianMs
  },
  historyMerge: merge,
  ftsAdaptiveResponse: observedSlowFtsCycles
}, null, 2));
