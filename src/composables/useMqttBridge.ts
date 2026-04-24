import { watch } from 'vue';
import { useConnectionStore, type ConnState } from '@/stores/connection';
import { useMessageStore } from '@/stores/messages';
import { useParamMemory } from './useParamMemory';
import type { MqttMessage } from '@shared/types';

interface PendingItem {
    connId: string;
    batch: MqttMessage[];
}

export function useMqttBridge() {
    const conn = useConnectionStore();
    const msg = useMessageStore();
    const paramMem = useParamMemory();
    let unsubMsg: (() => void) | null = null;
    let unsubState: (() => void) | null = null;
    let stopWatch: (() => void) | null = null;

    const pending: PendingItem[] = [];
    let rafId: number | null = null;
    let flushing = false;

    async function flush(): Promise<void> {
        if (flushing || pending.length === 0) return;
        flushing = true;
        try {
            const byConn = new Map<string, MqttMessage[]>();
            for (const it of pending.splice(0, pending.length)) {
                let arr = byConn.get(it.connId);
                if (!arr) {
                    arr = [];
                    byConn.set(it.connId, arr);
                }
                for (let i = 0; i < it.batch.length; i++) arr.push(it.batch[i]);
            }

            for (const [connId, list] of byConn) {
                let decodedBatch: Awaited<ReturnType<typeof window.api.pluginDecodeBatch>>['data'] | undefined;
                try {
                    const result = await window.api.pluginDecodeBatch(
                        list.map((item) => ({ topic: item.topic, payload: item.payload }))
                    );
                    if (result.success && result.data) decodedBatch = result.data;
                } catch (error) {
                    if (import.meta.env.DEV) console.warn('[plugin decode batch]', error);
                }

                if (decodedBatch) {
                    for (let i = 0; i < decodedBatch.length; i++) {
                        const decoded = decodedBatch[i];
                        if (!decoded?.rememberParams) continue;
                        for (const [key, value] of Object.entries(decoded.rememberParams)) {
                            if (value != null) paramMem.remember(key, String(value));
                        }
                    }
                }

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
            const connId = batch[0].connectionId;
            if (!connId) return;
            if (import.meta.env.DEV) {
                console.debug('[mqtt] batch:', connId, batch.length, batch[0]?.topic);
            }
            pending.push({ connId, batch });
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
    }

    function stop(): void {
        unsubMsg?.();
        unsubMsg = null;
        unsubState?.();
        unsubState = null;
        stopWatch?.();
        stopWatch = null;
        if (rafId != null) cancelAnimationFrame(rafId);
        rafId = null;
        pending.length = 0;
    }

    return { start, stop };
}
