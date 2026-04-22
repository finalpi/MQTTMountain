import { defineStore } from 'pinia';
import { markRaw, reactive } from 'vue';
import { RingBuffer } from '@/utils/ringBuffer';
import type { MqttMessage } from '@shared/types';

/** 单条消息（渲染侧） */
export interface MsgRow {
    topic: string;
    payload: string;
    time: number;
    seq: number;
}

/** 按主题的聚合视图 */
export interface TopicView {
    topic: string;
    buf: RingBuffer<MsgRow>;
    total: number;
    lastTime: number;
    lastSeq: number;
    disabled: boolean;
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
    topics: Map<string, TopicView>;
    topicsVersion: number;
    selectedTopic: string | null;
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

    const buckets = reactive(new Map<string, MsgBucket>());

    function createBucket(): MsgBucket {
        return {
            timeline: markRaw(new RingBuffer<MsgRow>(maxMemoryMessages)),
            timelineVersion: 0,
            topics: markRaw(new Map<string, TopicView>()),
            topicsVersion: 0,
            selectedTopic: null,
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
        maxMemoryMessages = Math.max(100, total);
        maxPerTopic = Math.max(50, perTopic);
        for (const b of buckets.values()) {
            b.timeline.setCapacity(maxMemoryMessages);
            for (const v of b.topics.values()) v.buf.setCapacity(maxPerTopic);
            b.timelineVersion++;
            b.topicsVersion++;
        }
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
                disabled: false,
                normTopic: topic.toLowerCase().replace(/\s+/gu, '')
            });
            b.topics.set(topic, v);
            b.topicsVersion++;
        }
        return v;
    }

    function ingest(connectionId: string, batch: MqttMessage[]): void {
        if (!connectionId || batch.length === 0) return;
        const b = bucketFor(connectionId);
        if (b.paused) return; // 该连接单独暂停显示
        for (let i = 0; i < batch.length; i++) {
            const m = batch[i];
            const row: MsgRow = { topic: m.topic, payload: m.payload, time: m.time, seq: nextSeq() };
            b.timeline.push(row);
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
                    disabled: false,
                    normTopic: m.topic.toLowerCase().replace(/\s+/gu, '')
                });
                nv.buf.push(row);
                b.topics.set(m.topic, nv);
            }
        }
        b.receiveCount += batch.length;
        b.timelineVersion++;
        b.topicsVersion++;
    }

    function clearAll(connectionId: string): void {
        const b = buckets.get(connectionId);
        if (!b) return;
        b.timeline.clear();
        b.topics.clear();
        b.timelineVersion++;
        b.topicsVersion++;
        b.receiveCount = 0;
        b.selectedTopic = null;
    }

    function clearTopic(connectionId: string, topic: string): void {
        const b = buckets.get(connectionId);
        if (!b) return;
        const v = b.topics.get(topic);
        if (!v) return;
        v.buf.clear();
        v.total = 0;
        b.topicsVersion++;
    }

    function removeTopic(connectionId: string, topic: string): void {
        const b = buckets.get(connectionId);
        if (!b) return;
        if (b.topics.delete(topic)) b.topicsVersion++;
        if (b.selectedTopic === topic) b.selectedTopic = null;
    }

    function selectTopic(connectionId: string, topic: string | null): void {
        const b = bucketFor(connectionId);
        b.selectedTopic = topic;
    }

    function setTopicDisabled(connectionId: string, topic: string, disabled: boolean): void {
        const b = buckets.get(connectionId);
        if (!b) return;
        const v = b.topics.get(topic);
        if (v) { v.disabled = disabled; b.topicsVersion++; }
    }

    function pushPublishHistory(connectionId: string, item: PublishHistoryItem): void {
        const b = bucketFor(connectionId);
        b.publishHistory.push(item);
        b.publishHistoryVersion++;
        b.publishCount++;
    }

    function setPaused(connectionId: string, paused: boolean): void {
        const b = bucketFor(connectionId);
        b.paused = paused;
    }

    function hydrate(connectionId: string, rows: { topic: string; payload: string; time: number }[]): void {
        if (!connectionId || !rows.length) return;
        const b = bucketFor(connectionId);
        const ordered = rows.slice().sort((a, b2) => a.time - b2.time);
        for (const r of ordered) {
            const row: MsgRow = { topic: r.topic, payload: r.payload, time: r.time, seq: nextSeq() };
            b.timeline.push(row);
            const v = ensureTopic(b, r.topic);
            v.buf.push(row);
            v.total++;
            v.lastTime = r.time;
            v.lastSeq = row.seq;
        }
        b.timelineVersion++;
        b.topicsVersion++;
    }

    /** 关闭连接（或删除配置）时清掉桶 */
    function dropBucket(connectionId: string): void {
        buckets.delete(connectionId);
    }

    return {
        buckets,
        bucketFor,
        hasBucket,
        setLimits,
        ingest,
        hydrate,
        clearAll,
        clearTopic,
        removeTopic,
        selectTopic,
        setTopicDisabled,
        pushPublishHistory,
        setPaused,
        dropBucket
    };
});
