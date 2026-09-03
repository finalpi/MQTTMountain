import assert from 'node:assert/strict';
import { buildUniqueTopicEntryNames } from '../src/utils/exporter';
import { filterRowsAfterClear } from '../src/utils/messageVisibility';
import { isValidTopicFilter, pickOutermost, topicFilterCovers } from '../src/utils/mqttFilter';
import { RingBuffer } from '../src/utils/ringBuffer';
import { createPinia, setActivePinia } from 'pinia';
import { useMessageStore } from '../src/stores/messages';
import { matchesNormalizedConditions } from '../src/utils/conditionMatcher';
import { consumeHydrationCredit, createHydrationCredits } from '../src/utils/hydrationCredits';
import { buildIncrementalSnapshot } from '../src/utils/incrementalSnapshot';

function testMqttFilterCoverage(): void {
    assert.equal(topicFilterCovers('a/+', 'a/#'), false);
    assert.equal(topicFilterCovers('a/#', 'a/+'), true);
    assert.equal(topicFilterCovers('#', '$SYS/#'), false);
    assert.equal(topicFilterCovers('$SYS/#', '$SYS/+'), true);
    assert.equal(topicFilterCovers('+/#', '$SYS/x'), false);
    assert.equal(isValidTopicFilter('a/#/b'), false);
    assert.equal(isValidTopicFilter('a+'), false);

    assert.deepEqual(
        pickOutermost([
            { topic: 'a/#', qos: 0 },
            { topic: 'a/b', qos: 2 }
        ]).map((item) => item.topic),
        ['a/#', 'a/b'],
        '低 QoS 外层订阅不能吞掉高 QoS 内层订阅'
    );
    assert.deepEqual(
        pickOutermost([
            { topic: 'a/#', qos: 2 },
            { topic: 'a/b', qos: 1 }
        ]).map((item) => item.topic),
        ['a/#']
    );
}

function testLeadingNotCondition(): void {
    assert.equal(matchesNormalizedConditions('alpha', [{ term: 'beta', join: 'not' }]), true);
    assert.equal(matchesNormalizedConditions('alpha beta', [{ term: 'beta', join: 'not' }]), false);
    assert.equal(matchesNormalizedConditions('alpha', [
        { term: 'beta', join: 'not' },
        { term: 'alpha', join: 'and' }
    ]), true);
}

function testVisibilityEpochs(): void {
    const rows = [
        { topic: 'a', time: 99 },
        { topic: 'a', time: 101 },
        { topic: 'b', time: 149 },
        { topic: 'b', time: 151 }
    ];
    assert.deepEqual(
        filterRowsAfterClear(rows, 100, new Map([['b', 150]])),
        [rows[1], rows[3]]
    );
}

function testRingBufferRemoval(): void {
    const ring = new RingBuffer(4);
    ring.push(1);
    ring.push(2);
    ring.push(3);
    const total = ring.total;
    assert.deepEqual(ring.removeWhere((value) => value % 2 === 0), [2]);
    assert.deepEqual(ring.snapshot(), [1, 3]);
    ring.setCapacity(2);
    assert.equal(ring.total, total, '调整容量不应伪造新写入');

    const wrapped = new RingBuffer<number>(3);
    wrapped.push(1);
    wrapped.push(2);
    wrapped.push(3);
    assert.equal(wrapped.push(4), 1);
    assert.deepEqual(wrapped.snapshot(), [2, 3, 4]);
    assert.equal(wrapped.shiftIf(2), true);
    wrapped.push(5);
    assert.deepEqual(wrapped.snapshot(), [3, 4, 5]);
    assert.deepEqual(wrapped.setCapacity(2), [3]);
    assert.deepEqual(wrapped.snapshot(), [4, 5]);
    wrapped.clear();
    wrapped.push(6);
    assert.deepEqual(wrapped.snapshot(), [6]);
}

function testZipEntryCollisions(): void {
    const names = buildUniqueTopicEntryNames(['a/b', 'a_b', 'A_B']);
    const values = [...names.values()];
    assert.equal(new Set(values.map((value) => value.toLowerCase())).size, values.length);
}

function mqttMessage(connectionId: string, topic: string, payload: string, time: number) {
    return { connectionId, topic, payload, time };
}

function testMessageStoreClearAndHydration(): void {
    setActivePinia(createPinia());
    const store = useMessageStore();
    const now = Date.now();

    store.ingest('clear-topic', [
        mqttMessage('clear-topic', 'a', 'old-a', now - 20),
        mqttMessage('clear-topic', 'b', 'old-b', now - 10)
    ]);
    store.selectTopic('clear-topic', 'a');
    store.clearTopic('clear-topic', 'a');
    store.selectTopic('clear-topic', 'b');
    store.selectTopic('clear-topic', 'a');
    assert.equal(store.bucketFor('clear-topic').topics.get('a')?.buf.length ?? 0, 0);
    assert.deepEqual(store.bucketFor('clear-topic').timeline.snapshot().map((row) => row.topic), ['b']);

    store.clearDisplay('display-clear');
    store.ingest('display-clear', [mqttMessage('display-clear', 'a', 'queued-before-clear', now - 1)]);
    assert.equal(store.bucketFor('display-clear').timeline.length, 0, '清屏前 pending 消息不得重新进入');
    assert.equal(store.mergeRecentSnapshot('display-clear', [{ topic: 'a', payload: 'old-history', time: now - 1 }]).length, 0);

    store.ingest('hydrate-gap', [mqttMessage('hydrate-gap', 'a', 'before-switch', now + 1)]);
    assert.equal(
        store.mergeRecentSnapshot('hydrate-gap', [
            { topic: 'a', payload: 'before-switch', time: now + 1 },
            { topic: 'a', payload: 'while-away', time: now + 2 }
        ]).length,
        1,
        'A→B→A 后应把离开期间的 recent 差额补回旧 bucket'
    );
    assert.deepEqual(
        store.bucketFor('hydrate-gap').timeline.snapshot().map((row) => row.payload),
        ['before-switch', 'while-away']
    );

    store.ingest('hydrate-pending', [mqttMessage('hydrate-pending', 'a', 'already-pending', now + 2)]);
    assert.equal(
        store.mergeRecentSnapshot('hydrate-pending', [{ topic: 'a', payload: 'already-pending', time: now + 2 }]).length,
        0,
        '已原子 drain 的 pending 若也在 recent 中，不得重复加入'
    );
    assert.equal(store.bucketFor('hydrate-pending').timeline.length, 1);

    store.ingest('hydrate-duplicates', [mqttMessage('hydrate-duplicates', 'a', 'same', now + 3)]);
    store.mergeRecentSnapshot('hydrate-duplicates', [
        { topic: 'a', payload: 'same', time: now + 3 },
        { topic: 'a', payload: 'same', time: now + 3 }
    ]);
    assert.equal(
        store.bucketFor('hydrate-duplicates').timeline.snapshot().filter((row) => row.payload === 'same').length,
        2,
        '按出现次数差额合并，不能把合法同毫秒重复报文折叠成一条'
    );

    const decodedRows = store.ingest('decode-version', [mqttMessage('decode-version', 'a', '{}', now + 4)]);
    const decodedBucket = store.bucketFor('decode-version');
    const rowsVersion = decodedBucket.timelineRowsVersion;
    const timelineVersion = decodedBucket.timelineVersion;
    store.applyDecodedRows('decode-version', decodedRows, [{ summary: '仅展示信息' }]);
    assert.equal(decodedBucket.timelineVersion, timelineVersion, '无 meta 解码不得制造无效响应式更新');
    store.applyDecodedRows('decode-version', decodedRows, [{ meta: { isReply: true, tid: 't' } }]);
    assert.equal(decodedBucket.timelineVersion, timelineVersion + 1);
    assert.equal(decodedBucket.timelineRowsVersion, rowsVersion, 'meta 更新不得触发消息列表和虚拟布局重算');
}

function testHydrationCredits(): void {
    const stored = { topic: 'a', payload: 'same', time: 100 };
    const ledger = createHydrationCredits(100, [stored, stored]);
    assert.equal(consumeHydrationCredit(ledger, stored), true);
    assert.equal(consumeHydrationCredit(ledger, stored), true);
    assert.equal(consumeHydrationCredit(ledger, stored), false, '合法第三次重复没有 credit，必须作为实时消息保留');
    assert.equal(
        consumeHydrationCredit(ledger, { topic: 'critical/unpersisted', payload: 'live', time: 99 }),
        false,
        '磁盘 critical 未落盘的迟到 IPC 没有 snapshot credit，不能按 cutoff 整体丢弃'
    );
    assert.equal(
        consumeHydrationCredit(createHydrationCredits(100, [stored]), { ...stored, time: 101 }),
        false,
        '边界后的实时消息不消费旧 snapshot credit'
    );
}

function testIncrementalPluginSnapshot(): void {
    const ring = new RingBuffer<{ seq: number }>(5);
    for (let seq = 1; seq <= 5; seq++) ring.push({ seq });
    const full = buildIncrementalSnapshot(ring, 3, 0);
    assert.equal(full.mode, 'full');
    assert.deepEqual(full.rows.map((row) => row.seq), [3, 4, 5]);
    assert.equal(full.latestSeq, 5);

    ring.push({ seq: 6 });
    ring.push({ seq: 7 });
    const delta = buildIncrementalSnapshot(ring, 3, 0, 0, 5);
    assert.equal(delta.mode, 'delta');
    assert.deepEqual(delta.rows.map((row) => row.seq), [6, 7]);
    assert.equal(buildIncrementalSnapshot(ring, 3, 0, 0, 1).mode, 'full', 'cursor 淘汰必须全量重置');
    assert.equal(buildIncrementalSnapshot(ring, 3, 1, 0, 7).mode, 'full', 'epoch 变化必须全量重置');

    const reordered = new RingBuffer<{ seq: number }>(5);
    reordered.push({ seq: 1 });
    reordered.push({ seq: 10 });
    reordered.push({ seq: 2 });
    const reorderedFull = buildIncrementalSnapshot(reordered, 5, 2);
    reordered.push({ seq: 11 });
    const reorderedDelta = buildIncrementalSnapshot(reordered, 5, 2, 2, reorderedFull.latestSeq ?? 0);
    assert.equal(reorderedDelta.mode, 'delta');
    assert.deepEqual(reorderedDelta.rows.map((row) => row.seq), [11]);
}

testMqttFilterCoverage();
testLeadingNotCondition();
testVisibilityEpochs();
testRingBufferRemoval();
testZipEntryCollisions();
testMessageStoreClearAndHydration();
testHydrationCredits();
testIncrementalPluginSnapshot();
console.log('renderer regressions: ok');
