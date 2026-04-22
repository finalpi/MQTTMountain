import { defineStore } from 'pinia';
import { markRaw, reactive, ref } from 'vue';
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
    /** 预计算的归一化 topic，用于过滤时命中 topic 本身 */
    normTopic: string;
}

/**
 * 消息存储：
 *   - timeline：全局环形缓冲（展示「时间线模式」）
 *   - topics：按主题分桶，每桶独立环形缓冲（展示「主题模式」右侧详情）
 *   - topicList：主题名顺序列表（Map.keys() 保持插入顺序；切换排序时重算）
 *   - selectedTopic：当前选中的主题
 *   - paused：暂停后仍接收主进程推送，但不再刷新 UI（通过 version 机制判定）
 */
export const useMessageStore = defineStore('messages', () => {
    // markRaw：RingBuffer 内部自维护 version/total，不应被 Vue 深层代理
    const timeline = markRaw(new RingBuffer<MsgRow>(2000));
    const timelineVersion = ref(0);
    const topics = markRaw(new Map<string, TopicView>());
    const topicsVersion = ref(0);
    const selectedTopic = ref<string | null>(null);
    const paused = ref(false);
    const receiveCount = ref(0);
    const publishCount = ref(0);
    const publishHistory = markRaw(new RingBuffer<{ topic: string; payload: string; qos: number; retain: boolean; time: number }>(50));
    const publishHistoryVersion = ref(0);

    let maxPerTopic = 500;

    function setLimits(total: number, perTopic: number): void {
        maxPerTopic = Math.max(50, perTopic);
        timeline.setCapacity(Math.max(100, total));
        for (const v of topics.values()) v.buf.setCapacity(maxPerTopic);
        timelineVersion.value++;
        topicsVersion.value++;
    }

    function ensureTopic(topic: string): TopicView {
        let v = topics.get(topic);
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
            topics.set(topic, v);
            topicsVersion.value++;
        }
        return v;
    }

    function ingest(batch: MqttMessage[]): void {
        if (batch.length === 0) return;
        for (let i = 0; i < batch.length; i++) {
            const m = batch[i];
            const row: MsgRow = { topic: m.topic, payload: m.payload, time: m.time, seq: m.seq };
            timeline.push(row);
            const v = topics.get(m.topic);
            if (v) {
                v.buf.push(row);
                v.total++;
                v.lastTime = m.time;
                v.lastSeq = m.seq;
            } else {
                const nv = markRaw<TopicView>({
                    topic: m.topic,
                    buf: new RingBuffer<MsgRow>(maxPerTopic),
                    total: 1,
                    lastTime: m.time,
                    lastSeq: m.seq,
                    disabled: false,
                    normTopic: m.topic.toLowerCase().replace(/\s+/gu, '')
                });
                nv.buf.push(row);
                topics.set(m.topic, nv);
            }
        }
        receiveCount.value += batch.length;
        timelineVersion.value++;
        topicsVersion.value++;
    }

    function clearAll(): void {
        timeline.clear();
        topics.clear();
        timelineVersion.value++;
        topicsVersion.value++;
        receiveCount.value = 0;
        selectedTopic.value = null;
    }

    function clearTopic(topic: string): void {
        const v = topics.get(topic);
        if (!v) return;
        v.buf.clear();
        v.total = 0;
        topicsVersion.value++;
    }

    function removeTopic(topic: string): void {
        if (topics.delete(topic)) topicsVersion.value++;
        if (selectedTopic.value === topic) selectedTopic.value = null;
    }

    function selectTopic(topic: string | null): void {
        selectedTopic.value = topic;
    }

    function setTopicDisabled(topic: string, disabled: boolean): void {
        const v = topics.get(topic);
        if (v) { v.disabled = disabled; topicsVersion.value++; }
    }

    function pushPublishHistory(item: { topic: string; payload: string; qos: number; retain: boolean; time: number }): void {
        publishHistory.push(item);
        publishHistoryVersion.value++;
        publishCount.value++;
    }

    /** 用主进程返回的「最近消息」预填 */
    function hydrate(rows: { topic: string; payload: string; time: number }[]): void {
        if (!rows.length) return;
        let seq = 0;
        const ordered = rows.slice().sort((a, b) => a.time - b.time);
        for (const r of ordered) {
            const row: MsgRow = { topic: r.topic, payload: r.payload, time: r.time, seq: ++seq };
            timeline.push(row);
            const v = ensureTopic(r.topic);
            v.buf.push(row);
            v.total++;
            v.lastTime = r.time;
            v.lastSeq = seq;
        }
        timelineVersion.value++;
        topicsVersion.value++;
    }

    return {
        timeline,
        timelineVersion,
        topics,
        topicsVersion,
        selectedTopic,
        paused,
        receiveCount,
        publishCount,
        publishHistory,
        publishHistoryVersion,
        setLimits,
        ingest,
        clearAll,
        clearTopic,
        removeTopic,
        selectTopic,
        setTopicDisabled,
        pushPublishHistory,
        hydrate
    };
});
