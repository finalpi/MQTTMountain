import { defineStore } from 'pinia';
import { markRaw, reactive } from 'vue';
import { RingBuffer } from '@/utils/ringBuffer';
import { filterRowsAfterClear, isRowAfterClear } from '@/utils/messageVisibility';
import { recordRendererPerf } from '@/utils/rendererPerf';
import type { MqttMessage } from '@shared/types';
import type { DecodedResult } from '@shared/plugin';

/** 单条消息（渲染侧） */
export interface MsgRow {
    topic: string;
    payload: string;
    time: number;
    seq: number;
    decoded?: DecodedResult | null;
}

/** 按主题的聚合视图 */
export interface TopicView {
    topic: string;
    buf: RingBuffer<MsgRow>;
    total: number;
    lastTime: number;
    lastSeq: number;
    disabled: boolean;
    pinned: boolean;
    normTopic: string;
}

export interface PublishHistoryItem {
    topic: string;
    payload: string;
    qos: number;
    retain: boolean;
    time: number;
}

/**
 * 每个连接一份独立数据桶
 * - timeline、topics 都用 markRaw 避免深层响应代理（内部用 version 触发更新）
 * - 其他原始类型字段由外层 reactive 代理后自动响应
 */
export interface MsgBucket {
    timeline: RingBuffer<MsgRow>;
    timelineVersion: number;
    timelineRowsVersion: number;
    /** 非追加式变化版本；供插件增量快照判断是否必须全量重置。 */
    messageEpoch: number;
    topics: Map<string, TopicView>;
    topicsVersion: number;
    topicOrder: string[];
    selectedTopic: string | null;
    /** 当前过滤结果需要优先保留的主题；选中主题始终自动保留。 */
    retainedTopics: Set<string>;
    /** 从连接配置恢复的禁用主题集合。 */
    configuredDisabledTopics: Set<string>;
    /** 单主题清屏基线，避免后续 hydration 把旧消息重新带回。 */
    topicClearTimes: Map<string, number>;
    paused: boolean;
    receiveCount: number;
    publishCount: number;
    publishHistory: RingBuffer<PublishHistoryItem>;
    publishHistoryVersion: number;
}

export const useMessageStore = defineStore('messages', () => {
    let maxMemoryMessages = 10000;
    let maxPerTopic = 500;
    let localSeqGen = 0;
    const nextSeq = (): number => ++localSeqGen;
    const displayClearTimes = new Map<string, number>();

    const buckets = reactive(new Map<string, MsgBucket>()) as Map<string, MsgBucket>;

    function createBucket(): MsgBucket {
        return {
            timeline: markRaw(new RingBuffer<MsgRow>(maxMemoryMessages)),
            timelineVersion: 0,
            timelineRowsVersion: 0,
            messageEpoch: 0,
            topics: markRaw(new Map<string, TopicView>()),
            topicsVersion: 0,
            topicOrder: [],
            selectedTopic: null,
            retainedTopics: markRaw(new Set<string>()),
            configuredDisabledTopics: markRaw(new Set<string>()),
            topicClearTimes: markRaw(new Map<string, number>()),
            paused: false,
            receiveCount: 0,
            publishCount: 0,
            publishHistory: markRaw(new RingBuffer<PublishHistoryItem>(50)),
            publishHistoryVersion: 0
        };
    }

    /** 获取或新建连接对应的 bucket；id 为空时返回一个临时 bucket（不写回 map） */
    function bucketFor(id: string | null | undefined): MsgBucket {
        if (!id) return createBucket();
        let b = buckets.get(id);
        if (!b) {
            b = createBucket();
            buckets.set(id, b);
        }
        return b;
    }

    function hasBucket(id: string | null | undefined): boolean {
        return !!id && buckets.has(id);
    }

    function setLimits(total: number, perTopic: number): void {
        maxMemoryMessages = Math.min(1_000_000, Math.max(100, Math.trunc(Number(total) || 100)));
        maxPerTopic = Math.min(100_000, Math.max(50, Math.trunc(Number(perTopic) || 50)));
        for (const b of buckets.values()) {
            const previousTimelineCapacity = b.timeline.capacity;
            const removed = b.timeline.setCapacity(maxMemoryMessages);
            for (const row of removed) detachTimelineRow(b, row);
            for (const v of b.topics.values()) v.buf.setCapacity(maxPerTopic);
            capRetainedTopics(b);
            pruneTopicMetadata(b);
            b.timelineVersion++;
            b.timelineRowsVersion++;
            if (previousTimelineCapacity !== b.timeline.capacity) b.messageEpoch++;
            b.topicsVersion++;
        }
    }

    function retainedTopicLimit(): number {
        // 被保护主题的行可能已经离开全局 timeline。限制保护集合后，额外保留的
        // MsgRow 引用/载荷总量最多约等于一份全局 timeline。
        return Math.max(1, Math.floor(maxMemoryMessages / Math.max(1, maxPerTopic)));
    }

    function capRetainedTopics(b: MsgBucket): void {
        const limit = retainedTopicLimit();
        if (b.retainedTopics.size <= limit) return;
        const keep = [...b.retainedTopics]
            .sort((a, b2) => (b.topics.get(b2)?.lastSeq ?? 0) - (b.topics.get(a)?.lastSeq ?? 0))
            .slice(0, limit);
        const keepSet = new Set(keep);
        const removed = [...b.retainedTopics].filter((topic) => !keepSet.has(topic));
        b.retainedTopics.clear();
        for (const topic of keep) b.retainedTopics.add(topic);
        for (const topic of removed) {
            if (topic !== b.selectedTopic) rebuildTopicFromTimeline(b, topic);
        }
    }

    function removeTopicMetadata(b: MsgBucket, topic: string): void {
        b.topics.delete(topic);
        b.topicOrder = b.topicOrder.filter((item) => item !== topic);
    }

    function recordTopicClear(b: MsgBucket, topic: string): void {
        b.topicClearTimes.delete(topic);
        b.topicClearTimes.set(topic, Date.now());
        const limit = Math.max(1_000, Math.min(10_000, maxMemoryMessages));
        while (b.topicClearTimes.size > limit) {
            const oldest = b.topicClearTimes.keys().next().value;
            if (oldest == null) break;
            b.topicClearTimes.delete(oldest);
        }
    }

    function pruneTopicMetadata(b: MsgBucket): void {
        const removed = new Set<string>();
        for (const [topic, view] of b.topics) {
            if (view.buf.length > 0 || topic === b.selectedTopic || b.retainedTopics.has(topic) || view.pinned || view.disabled) continue;
            b.topics.delete(topic);
            removed.add(topic);
        }
        if (removed.size === 0) return;
        b.topicOrder = b.topicOrder.filter((topic) => !removed.has(topic));
        b.topicsVersion++;
    }

    function detachTimelineRow(b: MsgBucket, row: MsgRow): void {
        if (b.selectedTopic === row.topic || b.retainedTopics.has(row.topic)) return;
        const view = b.topics.get(row.topic);
        view?.buf.shiftIf(row);
    }

    function rebuildTopicFromTimeline(b: MsgBucket, topic: string): void {
        const v = b.topics.get(topic);
        if (!v) return;
        const rows: MsgRow[] = [];
        b.timeline.forEachReverse((row) => {
            if (row.topic !== topic) return;
            rows.push(row);
            if (rows.length >= maxPerTopic) return false;
        });
        v.buf.clear();
        for (let i = rows.length - 1; i >= 0; i--) v.buf.push(rows[i]);
    }

    function pushTimelineRow(b: MsgBucket, row: MsgRow): void {
        const evicted = b.timeline.push(row);
        if (evicted) detachTimelineRow(b, evicted);
    }

    function ensureTopic(b: MsgBucket, topic: string): TopicView {
        let v = b.topics.get(topic);
        if (!v) {
            v = markRaw<TopicView>({
                topic,
                buf: new RingBuffer<MsgRow>(maxPerTopic),
                total: 0,
                lastTime: 0,
                lastSeq: 0,
                disabled: b.configuredDisabledTopics.has(topic),
                pinned: false,
                normTopic: topic.toLowerCase().replace(/\s+/gu, '')
            });
            b.topics.set(topic, v);
            b.topicOrder.push(topic);
            b.topicsVersion++;
        }
        return v;
    }

    function ingest(connectionId: string, batch: MqttMessage[], decodedBatch?: (DecodedResult | null)[]): MsgRow[] {
        if (!connectionId || batch.length === 0) return [];
        const b = bucketFor(connectionId);
        if (b.paused) return []; // 该连接单独暂停显示
        const displayClearedAt = displayClearTimes.get(connectionId) ?? 0;
        const rows: MsgRow[] = [];
        for (let i = 0; i < batch.length; i++) {
            const m = batch[i];
            if (!isRowAfterClear(m, displayClearedAt, b.topicClearTimes.get(m.topic) ?? 0)) continue;
            const row: MsgRow = {
                topic: m.topic,
                payload: m.payload,
                time: m.time,
                seq: nextSeq(),
                decoded: decodedBatch?.[i] ?? null
            };
            rows.push(row);
            pushTimelineRow(b, row);
            const existing = b.topics.get(m.topic);
            if (existing) {
                existing.buf.push(row);
                existing.total++;
                existing.lastTime = m.time;
                existing.lastSeq = row.seq;
            } else {
                const nv = markRaw<TopicView>({
                    topic: m.topic,
                    buf: new RingBuffer<MsgRow>(maxPerTopic),
                    total: 1,
                    lastTime: m.time,
                    lastSeq: row.seq,
                    disabled: b.configuredDisabledTopics.has(m.topic),
                    pinned: false,
                    normTopic: m.topic.toLowerCase().replace(/\s+/gu, '')
                });
                nv.buf.push(row);
                b.topics.set(m.topic, nv);
                b.topicOrder.push(m.topic);
            }
        }
        b.receiveCount += rows.length;
        capRetainedTopics(b);
        pruneTopicMetadata(b);
        if (rows.length === 0) return rows;
        b.timelineVersion++;
        b.timelineRowsVersion++;
        b.topicsVersion++;
        return rows;
    }

    function applyDecodedRows(connectionId: string, rows: MsgRow[], decodedBatch: (DecodedResult | null)[]): void {
        if (!connectionId || rows.length === 0 || decodedBatch.length === 0) return;
        const b = buckets.get(connectionId);
        if (!b) return;
        let changed = false;
        for (let i = 0; i < rows.length; i++) {
            const decoded = decodedBatch[i] ?? null;
            if (!decoded?.meta) continue;
            // The formatter decodes the selected message again when it opens. Keeping the
            // plugin's full tree/replyBlocks on every buffered row retained gigabytes of
            // renderer heap; reply correlation only needs the small meta object.
            rows[i].decoded = { meta: decoded.meta };
            changed = true;
        }
        if (!changed) return;
        // MsgRow 存在 markRaw 的环形缓冲中，必须显式触发依赖它的回执/详情计算。
        b.timelineVersion++;
    }

    function clearAll(connectionId: string): void {
        const b = buckets.get(connectionId);
        if (!b) return;
        b.timeline.clear();
        b.messageEpoch++;
        b.topics.clear();
        b.topicOrder = [];
        b.timelineVersion++;
        b.timelineRowsVersion++;
        b.topicsVersion++;
        b.receiveCount = 0;
        b.selectedTopic = null;
        b.retainedTopics.clear();
    }

    /** 用户清屏只建立显示基线，本地历史仍可在历史查询中访问。 */
    function clearDisplay(connectionId: string): void {
        clearAll(connectionId);
        displayClearTimes.set(connectionId, Date.now());
        const b = buckets.get(connectionId);
        b?.topicClearTimes.clear();
    }

    function clearTopic(connectionId: string, topic: string): void {
        const b = buckets.get(connectionId);
        if (!b) return;
        recordTopicClear(b, topic);
        const removed = b.timeline.removeWhere((row) => row.topic === topic);
        const v = b.topics.get(topic);
        if (v) {
            v.buf.clear();
            v.total = 0;
            v.lastTime = 0;
            v.lastSeq = 0;
        }
        if (removed.length > 0) {
            b.timelineVersion++;
            b.timelineRowsVersion++;
            b.messageEpoch++;
        }
        b.topicsVersion++;
    }

    function removeTopic(connectionId: string, topic: string): void {
        const b = buckets.get(connectionId);
        if (!b) return;
        recordTopicClear(b, topic);
        const removed = b.timeline.removeWhere((row) => row.topic === topic);
        const existed = b.topics.has(topic);
        removeTopicMetadata(b, topic);
        b.retainedTopics.delete(topic);
        if (b.selectedTopic === topic) b.selectedTopic = null;
        if (removed.length > 0) {
            b.timelineVersion++;
            b.timelineRowsVersion++;
            b.messageEpoch++;
        }
        if (existed || removed.length > 0) b.topicsVersion++;
    }

    function selectTopic(connectionId: string, topic: string | null): void {
        const b = bucketFor(connectionId);
        const previous = b.selectedTopic;
        b.selectedTopic = topic;
        if (previous && previous !== topic && !b.retainedTopics.has(previous)) {
            rebuildTopicFromTimeline(b, previous);
            b.topicsVersion++;
        }
    }

    function setRetainedTopics(connectionId: string, topics: Iterable<string>): void {
        const b = bucketFor(connectionId);
        const candidates = [...new Set(topics)]
            .filter((topic) => b.topics.has(topic))
            .sort((a, b2) => (b.topics.get(b2)?.lastSeq ?? 0) - (b.topics.get(a)?.lastSeq ?? 0));
        const next = new Set(candidates.slice(0, retainedTopicLimit()));
        let changed = next.size !== b.retainedTopics.size;
        if (!changed) {
            for (const topic of next) {
                if (!b.retainedTopics.has(topic)) {
                    changed = true;
                    break;
                }
            }
        }
        if (!changed) return;

        const removed = [...b.retainedTopics].filter((topic) => !next.has(topic));
        b.retainedTopics.clear();
        for (const topic of next) b.retainedTopics.add(topic);
        for (const topic of removed) {
            if (topic !== b.selectedTopic) rebuildTopicFromTimeline(b, topic);
        }
        if (removed.length > 0) b.topicsVersion++;
    }

    function setConfiguredDisabledTopics(connectionId: string, topics: Iterable<string>): void {
        const b = bucketFor(connectionId);
        const next = new Set(topics);
        b.configuredDisabledTopics.clear();
        for (const topic of next) b.configuredDisabledTopics.add(topic);
        let changed = false;
        for (const [topic, view] of b.topics) {
            const disabled = next.has(topic);
            if (view.disabled === disabled) continue;
            view.disabled = disabled;
            changed = true;
        }
        if (changed) b.topicsVersion++;
    }

    function setTopicDisabled(connectionId: string, topic: string, disabled: boolean): void {
        const b = bucketFor(connectionId);
        if (disabled) b.configuredDisabledTopics.add(topic);
        else b.configuredDisabledTopics.delete(topic);
        const v = b.topics.get(topic);
        if (v) { v.disabled = disabled; b.topicsVersion++; }
    }

    function reorderTopic(connectionId: string, topic: string, targetTopic: string): void {
        const b = buckets.get(connectionId);
        if (!b || topic === targetTopic) return;
        const fromIndex = b.topicOrder.indexOf(topic);
        const toIndex = b.topicOrder.indexOf(targetTopic);
        if (fromIndex < 0 || toIndex < 0) return;
        const next = b.topicOrder.slice();
        next.splice(fromIndex, 1);
        next.splice(toIndex, 0, topic);
        b.topicOrder = next;
        b.topicsVersion++;
    }

    function setTopicPinned(connectionId: string, topic: string, pinned: boolean): void {
        const b = buckets.get(connectionId);
        if (!b) return;
        const v = b.topics.get(topic);
        if (!v) return;
        v.pinned = pinned;
        const next = b.topicOrder.filter((item) => item !== topic);
        if (pinned) next.unshift(topic);
        else next.push(topic);
        b.topicOrder = next;
        b.topicsVersion++;
    }

    function pushPublishHistory(connectionId: string, item: PublishHistoryItem): void {
        const b = bucketFor(connectionId);
        b.publishHistory.push(item);
        b.publishHistoryVersion++;
        b.publishCount++;
    }

    function replacePublishHistory(connectionId: string, items: PublishHistoryItem[]): void {
        const b = bucketFor(connectionId);
        b.publishHistory.clear();
        for (const item of items.slice().sort((a, b2) => a.time - b2.time)) {
            b.publishHistory.push(item);
        }
        b.publishHistoryVersion++;
    }

    function setPaused(connectionId: string, paused: boolean): void {
        const b = bucketFor(connectionId);
        b.paused = paused;
    }

    type OccurrenceCounts = Map<number, Map<string, Map<string, number>>>;

    function addOccurrence(counts: OccurrenceCounts, row: { topic: string; payload: string; time: number }): void {
        let byTopic = counts.get(row.time);
        if (!byTopic) counts.set(row.time, byTopic = new Map());
        let byPayload = byTopic.get(row.topic);
        if (!byPayload) byTopic.set(row.topic, byPayload = new Map());
        byPayload.set(row.payload, (byPayload.get(row.payload) ?? 0) + 1);
    }

    function consumeOccurrence(counts: OccurrenceCounts, row: { topic: string; payload: string; time: number }): boolean {
        const byPayload = counts.get(row.time)?.get(row.topic);
        const remaining = byPayload?.get(row.payload) ?? 0;
        if (remaining <= 0) return false;
        if (remaining === 1) byPayload!.delete(row.payload);
        else byPayload!.set(row.payload, remaining - 1);
        return true;
    }

    /** 按出现次数差额合并 recent；合法重复报文仍分别保留。 */
    function mergeRecentSnapshot(
        connectionId: string,
        rows: { topic: string; payload: string; time: number }[],
        decodedBatch?: (DecodedResult | null)[]
    ): MsgRow[] {
        const startedAt = performance.now();
        if (!connectionId || !rows.length) return [];
        const b = bucketFor(connectionId);
        if (b.paused) return [];
        const visibleRows = filterRowsAfterClear(
            rows.map((row, index) => ({ row, decoded: decodedBatch?.[index] ?? null, topic: row.topic, time: row.time })),
            displayClearTimes.get(connectionId) ?? 0,
            b.topicClearTimes
        ).sort((a, b2) => a.time - b2.time);
        if (!visibleRows.length || b.paused) return [];

        const remainingExisting: OccurrenceCounts = new Map();
        const currentTimeline = b.timeline.snapshot();
        const existingRows = new Set<MsgRow>(currentTimeline);
        for (const view of b.topics.values()) {
            for (const row of view.buf.snapshot()) existingRows.add(row);
        }
        for (const row of existingRows) addOccurrence(remainingExisting, row);
        const additions: MsgRow[] = [];
        for (const item of visibleRows) {
            const r = item.row;
            if (consumeOccurrence(remainingExisting, r)) continue;
            const row: MsgRow = {
                topic: r.topic,
                payload: r.payload,
                time: r.time,
                seq: nextSeq(),
                decoded: item.decoded
            };
            additions.push(row);
        }
        if (!additions.length) {
            recordRendererPerf('message.hydration-merge', performance.now() - startedAt, visibleRows.length);
            return [];
        }

        const combined = [...currentTimeline, ...additions]
            .sort((a, b2) => a.time - b2.time || a.seq - b2.seq)
            .slice(-maxMemoryMessages);
        b.timeline = markRaw(new RingBuffer<MsgRow>(maxMemoryMessages));
        for (const row of combined) b.timeline.push(row);
        const timelineRows = new Set(combined);

        const additionsByTopic = new Map<string, MsgRow[]>();
        for (const row of additions) {
            const list = additionsByTopic.get(row.topic) ?? [];
            list.push(row);
            additionsByTopic.set(row.topic, list);
        }
        for (const [topic, topicAdditions] of additionsByTopic) {
            const view = ensureTopic(b, topic);
            const seen = new Set<MsgRow>();
            const protectedTopic = topic === b.selectedTopic || b.retainedTopics.has(topic);
            const ordered = [...view.buf.snapshot(), ...topicAdditions]
                .filter((row) => {
                    if (seen.has(row) || (!protectedTopic && !timelineRows.has(row))) return false;
                    seen.add(row);
                    return true;
                })
                .sort((a, b2) => a.time - b2.time || a.seq - b2.seq)
                .slice(-maxPerTopic);
            view.buf = markRaw(new RingBuffer<MsgRow>(maxPerTopic));
            for (const row of ordered) view.buf.push(row);
            view.total += topicAdditions.length;
            const last = ordered[ordered.length - 1];
            view.lastTime = last?.time ?? 0;
            view.lastSeq = last?.seq ?? 0;
        }
        for (const [topic, view] of b.topics) {
            if (additionsByTopic.has(topic) || topic === b.selectedTopic || b.retainedTopics.has(topic)) continue;
            const kept = view.buf.snapshot().filter((row) => timelineRows.has(row));
            if (kept.length === view.buf.length) continue;
            view.buf = markRaw(new RingBuffer<MsgRow>(maxPerTopic));
            for (const row of kept.slice(-maxPerTopic)) view.buf.push(row);
        }

        b.receiveCount += additions.length;
        b.messageEpoch++;
        capRetainedTopics(b);
        pruneTopicMetadata(b);
        b.timelineVersion++;
        b.timelineRowsVersion++;
        b.topicsVersion++;
        recordRendererPerf('message.hydration-merge', performance.now() - startedAt, visibleRows.length);
        return additions;
    }

    function isVisibleAtCurrentClearEpoch(connectionId: string, row: { topic: string; time: number }): boolean {
        const b = bucketFor(connectionId);
        return isRowAfterClear(
            row,
            displayClearTimes.get(connectionId) ?? 0,
            b.topicClearTimes.get(row.topic) ?? 0
        );
    }

    /** 删除连接配置时清掉 bucket；普通断开保留离线查看和暂停状态。 */
    function dropBucket(connectionId: string, forgetDisplayClear = false): void {
        buckets.delete(connectionId);
        if (forgetDisplayClear) displayClearTimes.delete(connectionId);
    }

    return {
        buckets,
        bucketFor,
        hasBucket,
        setLimits,
        ingest,
        applyDecodedRows,
        mergeRecentSnapshot,
        isVisibleAtCurrentClearEpoch,
        clearAll,
        clearDisplay,
        clearTopic,
        removeTopic,
        selectTopic,
        setRetainedTopics,
        setConfiguredDisabledTopics,
        setTopicDisabled,
        reorderTopic,
        setTopicPinned,
        pushPublishHistory,
        replacePublishHistory,
        setPaused,
        dropBucket
    };
});
