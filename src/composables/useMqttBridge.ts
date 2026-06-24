import { watch } from 'vue';
import { useConnectionStore, type ConnState } from '@/stores/connection';
import { useMessageStore } from '@/stores/messages';
import { useParamMemory } from './useParamMemory';
import type { MqttMessage } from '@shared/types';
import type { DecodedResult } from '@shared/plugin';

export function useMqttBridge() {
    const conn = useConnectionStore();
    const msg = useMessageStore();
    const paramMem = useParamMemory();
    let unsubMsg: (() => void) | null = null;
    let unsubState: (() => void) | null = null;
    let stopWatch: (() => void) | null = null;
    let stopActiveWatch: (() => void) | null = null;

    const pending: MqttMessage[] = [];
    let rafId: number | null = null;
    let flushing = false;
    let activeHydrateToken = 0;

    async function hydrateActiveConnection(connectionId: string): Promise<void> {
        const token = ++activeHydrateToken;
        const recent = await window.api.mqttReadRecent({ connectionId, limit: 300 });
        if (token !== activeHydrateToken || conn.selectedId !== connectionId) return;
        if (!recent.success || !recent.data?.length) return;
        msg.clearAll(connectionId);
        await msg.hydrate(connectionId, recent.data);
    }

    function rememberDecodedParams(decodedBatch: (DecodedResult | null)[]): void {
        for (let i = 0; i < decodedBatch.length; i++) {
            const decoded = decodedBatch[i];
            if (!decoded?.rememberParams) continue;
            for (const [key, value] of Object.entries(decoded.rememberParams)) {
                if (Array.isArray(value)) {
                    for (let i = value.length - 1; i >= 0; i -= 1) {
                        paramMem.remember(key, value[i]);
                    }
                } else if (value != null) {
                    paramMem.remember(key, String(value));
                }
            }
        }
    }

    async function decodeVisibleTopicBatch(connId: string, list: MqttMessage[]): Promise<(DecodedResult | null)[] | undefined> {
        const selectedTopic = msg.buckets.get(connId)?.selectedTopic;
        if (!selectedTopic) return undefined;
        const visibleItems: { index: number; topic: string; payload: string }[] = [];
        for (let i = 0; i < list.length; i++) {
            const item = list[i];
            if (item.topic === selectedTopic) visibleItems.push({ index: i, topic: item.topic, payload: item.payload });
        }
        if (visibleItems.length === 0) return undefined;
        const result = await window.api.pluginDecodeBatch(
            visibleItems.map((item) => ({ topic: item.topic, payload: item.payload }))
        );
        if (!result.success || !result.data) return undefined;
        const decodedBatch = new Array<DecodedResult | null>(list.length).fill(null);
        for (let i = 0; i < visibleItems.length; i++) {
            decodedBatch[visibleItems[i].index] = result.data[i] ?? null;
        }
        return decodedBatch;
    }

    async function flush(): Promise<void> {
        if (flushing || pending.length === 0) return;
        flushing = true;
        try {
            const byConn = new Map<string, MqttMessage[]>();
            const batch = pending.splice(0, pending.length);
            for (let i = 0; i < batch.length; i++) {
                const item = batch[i];
                if (!item.connectionId) continue;
                let arr = byConn.get(item.connectionId);
                if (!arr) {
                    arr = [];
                    byConn.set(item.connectionId, arr);
                }
                arr.push(item);
            }

            for (const [connId, list] of byConn) {
                if (connId !== conn.selectedId) continue;
                let decodedBatch: (DecodedResult | null)[] | undefined;
                try {
                    decodedBatch = await decodeVisibleTopicBatch(connId, list);
                } catch (error) {
                    if (import.meta.env.DEV) console.warn('[plugin decode batch]', error);
                }

                if (decodedBatch) rememberDecodedParams(decodedBatch);
                msg.ingest(connId, list, decodedBatch);
            }
        } finally {
            flushing = false;
            if (pending.length > 0) schedule();
        }
    }

    function schedule(): void {
        if (rafId != null) return;
        rafId = requestAnimationFrame(async () => {
            rafId = null;
            await flush();
        });
    }

    function start(): void {
        unsubMsg = window.api.onMqttMessages((batch) => {
            if (!batch.length) return;
            if (import.meta.env.DEV) {
                const connIds = new Set(batch.map((item) => item.connectionId).filter(Boolean));
                console.debug('[mqtt] batch:', [...connIds].join(','), batch.length, batch[0]?.topic);
            }
            pending.push(...batch);
            schedule();
        });

        unsubState = window.api.onMqttState((p) => {
            if (import.meta.env.DEV) {
                console.debug('[mqtt] state:', p.connectionId, p.state, p.message);
            }
            conn.setState(p.connectionId, p.state as ConnState, p.message);
        });

        stopWatch = watch(
            () => {
                const cid = conn.selectedId;
                const bucket = cid ? msg.buckets.get(cid) : null;
                return [cid, bucket?.selectedTopic ?? null] as const;
            },
            ([cid, topic]) => {
                if (!cid) return;
                window.api.mqttSetPriorityTopic({ connectionId: cid, topic });
            }
        );

        stopActiveWatch = watch(
            () => {
                const cid = conn.selectedId;
                const bucket = cid ? msg.buckets.get(cid) : null;
                return [cid, bucket?.paused ?? false] as const;
            },
            ([cid, paused]) => {
                activeHydrateToken++;
                pending.length = 0;
                window.api.mqttSetActiveConnection({ connectionId: cid });
                if (cid) window.api.mqttSetDisplayPaused({ connectionId: cid, paused });
                if (cid && !paused) void hydrateActiveConnection(cid);
            },
            { immediate: true }
        );
    }

    function stop(): void {
        unsubMsg?.();
        unsubMsg = null;
        unsubState?.();
        unsubState = null;
        stopWatch?.();
        stopWatch = null;
        stopActiveWatch?.();
        stopActiveWatch = null;
        window.api.mqttSetActiveConnection({ connectionId: null });
        activeHydrateToken++;
        if (rafId != null) cancelAnimationFrame(rafId);
        rafId = null;
        pending.length = 0;
    }

    return { start, stop };
}
