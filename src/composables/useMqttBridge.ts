import { watch } from 'vue';
import { useConnectionStore, type ConnState } from '@/stores/connection';
import { useMessageStore, type MsgRow } from '@/stores/messages';
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
    const decodePending: { connectionId: string; topic: string; row: MsgRow }[] = [];
    let rafId: number | null = null;
    let renderTimer: number | null = null;
    let flushing = false;
    let decoding = false;
    let decodeTimer: number | null = null;
    let decodeGeneration = 0;
    let activeHydrateToken = 0;
    const RENDER_BATCH_LIMIT = 1000;
    const RENDER_INPUT_BATCH_LIMIT = 300;
    const RENDER_INPUT_DELAY_MS = 50;
    const RENDER_PENDING_LIMIT = 12000;
    const DECODE_BATCH_LIMIT = 300;
    const DECODE_INPUT_BATCH_LIMIT = 50;
    const DECODE_INPUT_DELAY_MS = 80;
    const DECODE_QUEUE_LIMIT = 3000;

    function isTextInputActive(): boolean {
        const el = document.activeElement;
        if (!el) return false;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
        return el instanceof HTMLElement && el.isContentEditable;
    }

    function yieldToInput(): Promise<void> {
        return new Promise((resolve) => window.setTimeout(resolve, isTextInputActive() ? 16 : 0));
    }

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

    function enqueueDecodeRows(connectionId: string, rows: MsgRow[]): void {
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            decodePending.push({ connectionId, topic: row.topic, row });
        }
        if (decodePending.length > DECODE_QUEUE_LIMIT) {
            decodePending.splice(0, decodePending.length - DECODE_QUEUE_LIMIT);
        }
        scheduleDecode();
    }

    function scheduleDecode(): void {
        if (decoding || decodeTimer != null || decodePending.length === 0) return;
        decodeTimer = window.setTimeout(() => {
            decodeTimer = null;
            void runDecodeQueue();
        }, isTextInputActive() ? DECODE_INPUT_DELAY_MS : 0);
    }

    async function runDecodeQueue(): Promise<void> {
        if (decoding || decodePending.length === 0) return;
        decoding = true;
        const generation = decodeGeneration;
        try {
            while (decodePending.length > 0 && generation === decodeGeneration) {
                const selectedConnection = conn.selectedId;
                if (!selectedConnection) {
                    decodePending.length = 0;
                    return;
                }
                const decodeLimit = isTextInputActive() ? DECODE_INPUT_BATCH_LIMIT : DECODE_BATCH_LIMIT;
                const batch = decodePending
                    .splice(0, decodeLimit)
                    .filter((item) => item.connectionId === selectedConnection);
                if (batch.length === 0) continue;
                const result = await window.api.pluginDecodeBatch(
                    batch.map((item) => ({ topic: item.topic, payload: item.row.payload }))
                );
                if (generation !== decodeGeneration) return;
                if (!result.success || !result.data) continue;
                const decodedBatch = batch.map((_, i) => result.data?.[i] ?? null);
                rememberDecodedParams(decodedBatch);
                msg.applyDecodedRows(selectedConnection, batch.map((item) => item.row), decodedBatch);
                await yieldToInput();
            }
        } catch (error) {
            if (import.meta.env.DEV) console.warn('[plugin decode batch]', error);
        } finally {
            decoding = false;
            if (decodePending.length > 0 && generation === decodeGeneration) scheduleDecode();
        }
    }

    async function flush(): Promise<void> {
        if (flushing || pending.length === 0) return;
        flushing = true;
        try {
            const byConn = new Map<string, MqttMessage[]>();
            const renderLimit = isTextInputActive() ? RENDER_INPUT_BATCH_LIMIT : RENDER_BATCH_LIMIT;
            const batch = pending.splice(0, Math.min(pending.length, renderLimit));
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
                const rows = msg.ingest(connId, list);
                enqueueDecodeRows(connId, rows);
            }
        } finally {
            flushing = false;
            if (pending.length > 0) schedule();
        }
    }

    function schedule(): void {
        if (rafId != null || renderTimer != null) return;
        if (isTextInputActive()) {
            renderTimer = window.setTimeout(() => {
                renderTimer = null;
                rafId = requestAnimationFrame(async () => {
                    rafId = null;
                    await flush();
                });
            }, RENDER_INPUT_DELAY_MS);
            return;
        }
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
            if (pending.length > RENDER_PENDING_LIMIT) {
                pending.splice(0, pending.length - RENDER_PENDING_LIMIT);
            }
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
                decodeGeneration++;
                pending.length = 0;
                decodePending.length = 0;
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
        decodeGeneration++;
        if (rafId != null) cancelAnimationFrame(rafId);
        if (renderTimer != null) clearTimeout(renderTimer);
        if (decodeTimer != null) clearTimeout(decodeTimer);
        rafId = null;
        renderTimer = null;
        decodeTimer = null;
        pending.length = 0;
        decodePending.length = 0;
    }

    return { start, stop };
}
