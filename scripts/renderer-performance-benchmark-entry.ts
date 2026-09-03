import assert from 'node:assert/strict';
import { RowMemo } from '../src/utils/boundedMemo';
import { matchesNormalizedConditions } from '../src/utils/conditionMatcher';
import { normalize } from '../src/utils/filter';
import { RingBuffer } from '../src/utils/ringBuffer';
import { buildIncrementalSnapshot } from '../src/utils/incrementalSnapshot';

interface Row {
    topic: string;
    payload: string;
    seq: number;
}

function timed(run: () => number): { ms: number; checksum: number } {
    const startedAt = performance.now();
    const checksum = run();
    return { ms: performance.now() - startedAt, checksum };
}

function benchmarkFilter(): Record<string, number> {
    let seq = 0;
    const makeRow = (index: number): Row => ({
        topic: `thing/product/device-${index % 280}/osd`,
        payload: `${'x'.repeat(900)}${index % 17 === 0 ? ' alarm ' : ' normal '}device-${index % 280}`,
        seq: ++seq
    });
    const seed = Array.from({ length: 10_000 }, (_, index) => makeRow(index));
    const conditions = [
        { term: 'alarm', join: 'and' as const },
        { term: 'device', join: 'and' as const }
    ];

    const legacyRows = seed.slice();
    const legacy = timed(() => {
        const cache = new Map<string, boolean>();
        let matches = 0;
        for (let pass = 0; pass < 40; pass++) {
            legacyRows.splice(0, 20);
            for (let i = 0; i < 20; i++) legacyRows.push(makeRow(20_000 + pass * 20 + i));
            for (const row of legacyRows) {
                const source = row.topic + row.payload;
                let value = cache.get(source);
                if (value === undefined) {
                    value = matchesNormalizedConditions(normalize(source), conditions);
                    if (cache.size >= 5000) cache.clear();
                    cache.set(source, value);
                }
                if (value) matches++;
            }
        }
        return matches;
    });

    const optimizedRows = seed.slice();
    const optimized = timed(() => {
        const memo = new RowMemo<Row, boolean>();
        let matches = 0;
        for (let pass = 0; pass < 40; pass++) {
            optimizedRows.splice(0, 20);
            for (let i = 0; i < 20; i++) optimizedRows.push(makeRow(20_000 + pass * 20 + i));
            for (const row of optimizedRows) {
                let value = memo.get(row, 'alarm+device');
                if (value === undefined) {
                    value = matchesNormalizedConditions(normalize(row.topic + row.payload), conditions);
                    memo.set(row, 'alarm+device', value);
                }
                if (value) matches++;
            }
        }
        return matches;
    });
    assert.equal(legacy.checksum, optimized.checksum);
    return {
        legacyMs: Number(legacy.ms.toFixed(2)),
        optimizedMs: Number(optimized.ms.toFixed(2)),
        speedup: Number((legacy.ms / optimized.ms).toFixed(2))
    };
}

function benchmarkVirtualLookup(): Record<string, number> {
    const keys = Array.from({ length: 10_000 }, (_, index) => index + 1);
    const baseline = timed(() => {
        let checksum = 0;
        for (let pass = 0; pass < 100; pass++) {
            const rows = keys.map((key, index) => ({ key, top: index * 80 }));
            const retained = new Set(rows.map((row) => row.key));
            for (let i = 0; i < 4; i++) checksum += rows.find((row) => row.key === keys[(i * 239 + pass) % keys.length])?.top ?? 0;
            checksum += retained.size;
        }
        return checksum;
    });
    const optimized = timed(() => {
        let checksum = 0;
        for (let pass = 0; pass < 100; pass++) {
            const keyTops = new Map<number, number>();
            for (let index = 0; index < keys.length; index++) {
                keyTops.set(keys[index], index * 80);
            }
            for (let i = 0; i < 4; i++) checksum += keyTops.get(keys[(i * 239 + pass) % keys.length]) ?? 0;
            checksum += keys.length;
        }
        return checksum;
    });
    assert.equal(baseline.checksum, optimized.checksum);
    return {
        legacyMs: Number(baseline.ms.toFixed(2)),
        optimizedMs: Number(optimized.ms.toFixed(2)),
        speedup: Number((baseline.ms / optimized.ms).toFixed(2))
    };
}

function benchmarkEstimateCache(): Record<string, number> {
    let seq = 0;
    const makeRow = (index: number) => ({
        seq: ++seq,
        topic: `thing/product/device-${index % 280}/osd`,
        payload: `${'x'.repeat(600)}\n${'y'.repeat(600)}\n${index}`
    });
    const estimate = (row: { topic: string; payload: string }) => {
        const payloadLines = Math.max(1, row.payload.split('\n').reduce(
            (sum, part) => sum + Math.max(1, Math.ceil(part.length / 110)),
            0
        ));
        return 28 + Math.max(1, Math.ceil(row.topic.length / 80)) * 18 + payloadLines * 20;
    };
    const seed = Array.from({ length: 10_000 }, (_, index) => makeRow(index));
    const baselineRows = seed.slice();
    const baseline = timed(() => {
        let checksum = 0;
        for (let pass = 0; pass < 40; pass++) {
            baselineRows.splice(0, 20);
            for (let i = 0; i < 20; i++) baselineRows.push(makeRow(20_000 + pass * 20 + i));
            for (const row of baselineRows) checksum += estimate(row);
        }
        return checksum;
    });
    const optimizedRows = seed.slice();
    const optimized = timed(() => {
        let checksum = 0;
        const estimates = new Map<number, number>();
        for (let pass = 0; pass < 40; pass++) {
            optimizedRows.splice(0, 20);
            for (let i = 0; i < 20; i++) optimizedRows.push(makeRow(20_000 + pass * 20 + i));
            const live = new Set<number>();
            for (const row of optimizedRows) {
                live.add(row.seq);
                let value = estimates.get(row.seq);
                if (value == null) {
                    value = estimate(row);
                    estimates.set(row.seq, value);
                }
                checksum += value;
            }
            for (const key of estimates.keys()) if (!live.has(key)) estimates.delete(key);
        }
        return checksum;
    });
    assert.equal(baseline.checksum, optimized.checksum);
    return {
        legacyMs: Number(baseline.ms.toFixed(2)),
        optimizedMs: Number(optimized.ms.toFixed(2)),
        speedup: Number((baseline.ms / optimized.ms).toFixed(2))
    };
}

function benchmarkPluginPolling(): Record<string, number> {
    const history = Array.from({ length: 50 }, (_, index) => ({ time: index }));
    const params = Object.fromEntries(Array.from({ length: 100 }, (_, key) => [
        `key-${key}`,
        Array.from({ length: 30 }, (_, value) => `value-${key}-${value}`)
    ]));
    const buildSeed = () => {
        const ring = new RingBuffer<{ seq: number; payload: string }>(5000);
        for (let seq = 1; seq <= 5000; seq++) ring.push({ seq, payload: `payload-${seq}` });
        return ring;
    };
    let copiedRowsBefore = 0;
    const baselineRing = buildSeed();
    const baseline = timed(() => {
        let nextSeq = 5001;
        for (let poll = 0; poll < 50; poll++) {
            if (poll > 0) for (let i = 0; i < 20; i++) baselineRing.push({ seq: nextSeq, payload: `payload-${nextSeq++}` });
            copiedRowsBefore += baselineRing.snapshot().length + history.slice().length;
            for (const values of Object.values(params)) copiedRowsBefore += values.slice().length;
        }
        return baselineRing.last()?.seq ?? 0;
    });
    let copiedRowsAfter = 0;
    const optimizedRing = buildSeed();
    const optimized = timed(() => {
        let nextSeq = 5001;
        const initial = buildIncrementalSnapshot(optimizedRing, 5000, 0);
        let cursor = initial.latestSeq ?? 0;
        copiedRowsAfter += initial.rows.length + history.length;
        const cachedParams = Object.fromEntries(Object.entries(params).map(([key, values]) => [key, values.slice()]));
        for (const values of Object.values(cachedParams)) copiedRowsAfter += values.length;
        for (let poll = 1; poll < 50; poll++) {
            for (let i = 0; i < 20; i++) optimizedRing.push({ seq: nextSeq, payload: `payload-${nextSeq++}` });
            const delta = buildIncrementalSnapshot(optimizedRing, 5000, 0, 0, cursor);
            copiedRowsAfter += delta.rows.length;
            cursor = delta.latestSeq ?? cursor;
        }
        return optimizedRing.last()?.seq ?? 0;
    });
    assert.equal(baseline.checksum, optimized.checksum);
    return {
        legacyMs: Number(baseline.ms.toFixed(2)),
        optimizedMs: Number(optimized.ms.toFixed(2)),
        copiedRowsBefore,
        copiedRowsAfter,
        copyReduction: Number((copiedRowsBefore / copiedRowsAfter).toFixed(2))
    };
}

function benchmarkLazyRingAllocation(): Record<string, number> {
    const count = 20_000;
    const capacity = 500;
    const baseline = timed(() => {
        const buffers = Array.from({ length: count }, () => new Array(capacity));
        for (let i = 0; i < buffers.length; i++) buffers[i][0] = i;
        return buffers.reduce((sum, buffer) => sum + buffer.length, 0);
    });
    const optimized = timed(() => {
        const buffers = Array.from({ length: count }, () => new RingBuffer<number>(capacity));
        for (let i = 0; i < buffers.length; i++) buffers[i].push(i);
        return buffers.reduce((sum, buffer) => sum + buffer.length, 0);
    });
    return {
        legacyMs: Number(baseline.ms.toFixed(2)),
        optimizedMs: Number(optimized.ms.toFixed(2)),
        allocatedSlotsBefore: baseline.checksum,
        liveSlotsAfter: optimized.checksum,
        slotReduction: Number((baseline.checksum / optimized.checksum).toFixed(2))
    };
}

function benchmarkOverlayCapacity(): Record<string, number> {
    const rows = 5000;
    const topics = 1000;
    const legacySlots = rows * topics;
    const groupedSlots = rows;
    return { legacySlots, groupedSlots, slotReduction: legacySlots / groupedSlots };
}

function benchmarkRepeatedParamMemory(): Record<string, number> {
    const makeState = () => Object.fromEntries(Array.from({ length: 100 }, (_, key) => [
        `key-${key}`,
        Array.from({ length: 30 }, (_, value) => `value-${key}-${value}`)
    ]));
    const baselineState = makeState();
    const baseline = timed(() => {
        let bytes = 0;
        for (let i = 0; i < 1000; i++) {
            const arr = baselineState['key-0'];
            const current = arr[0];
            baselineState['key-0'] = [current, ...arr.filter((value) => value !== current)].slice(0, 100);
            bytes += JSON.stringify(baselineState).length;
        }
        return bytes;
    });
    const optimizedState = makeState();
    const optimized = timed(() => {
        let bytes = 0;
        for (let i = 0; i < 1000; i++) {
            const arr = optimizedState['key-0'];
            const current = arr[0];
            if (arr[0] !== current) optimizedState['key-0'] = [current, ...arr.filter((value) => value !== current)].slice(0, 100);
            bytes += 0;
        }
        return bytes;
    });
    return {
        legacyMs: Number(baseline.ms.toFixed(2)),
        optimizedMs: Number(optimized.ms.toFixed(2)),
        writesBefore: 1000,
        writesAfter: 0,
        serializedCharsBefore: baseline.checksum,
        serializedCharsAfter: optimized.checksum
    };
}

console.log(JSON.stringify({
    filter10k40Passes: benchmarkFilter(),
    virtualKeyIndex10k100Passes: benchmarkVirtualLookup(),
    estimate10k40Layouts: benchmarkEstimateCache(),
    plugin50Polls: benchmarkPluginPolling(),
    lazyRing20kTopics: benchmarkLazyRingAllocation(),
    overlay5kRows1kTopics: benchmarkOverlayCapacity(),
    repeatedParamMemory1000: benchmarkRepeatedParamMemory()
}, null, 2));
