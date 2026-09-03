import { watch } from 'vue';
import { useConnectionStore, type ConnState } from '@/stores/connection';
import { useMessageStore, type MsgRow } from '@/stores/messages';
import { usePluginStore } from '@/stores/plugins';
import { useParamMemory } from './useParamMemory';
import {
    installTextInputActivityTracking,
    isTextInputBusy,
    isTextInputFocused,
    textInputBusyRemainingMs
} from '@/utils/textInputActivity';
import type { MqttMessage } from '@shared/types';
import type { DecodedResult } from '@shared/plugin';
import { consumeHydrationCredit, createHydrationCredits, type HydrationCreditLedger } from '@/utils/hydrationCredits';
import { recordRendererPerf } from '@/utils/rendererPerf';

export function useMqttBridge() {
    const conn = useConnectionStore();
    const msg = useMessageStore();
    const plugins = usePluginStore();
    const paramMem = useParamMemory();
    let unsubMsg: (() => void) | null = null;
    let unsubState: (() => void) | null = null;
    let stopWatch: (() => void) | null = null;
    let stopActiveWatch: (() => void) | null = null;
    let stopInputActivityTracking: (() => void) | null = null;
    let stopPluginWatch: (() => void) | null = null;

    const pending: MqttMessage[] = [];
    const decodePending: { connectionId: string; topic: string; row: MsgRow }[] = [];
    let rafId: number | null = null;
    let renderTimer: number | null = null;
    let flushing = false;
    let decoding = false;
    let decodeTimer: number | null = null;
    let decodeGeneration = 0;
    let activeHydrateToken = 0;
    const hydrationCredits = new Map<string, HydrationCreditLedger>();
    const decoderTopicCache = new Map<string, boolean>();
    let renderCostEma = 0;
    const RENDER_BATCH_LIMIT = 1000;
    const RENDER_INPUT_BATCH_LIMIT = 120;
    const RENDER_BACKLOG_BATCH_LIMIT = 1600;
    const RENDER_INPUT_DELAY_MS = 120;
    const RENDER_SLOW_DELAY_MS = 50;
    const RENDER_BACKLOG_DELAY_MS = 80;
    const RENDER_PENDING_LIMIT = 12000;
    const DECODE_BATCH_LIMIT = 300;
    const DECODE_INPUT_BATCH_LIMIT = 30;
    const DECODE_INPUT_DELAY_MS = 160;
    const DECODE_QUEUE_LIMIT = 3000;
    let inputDeferredAt = 0;
    let inputDeferredRenderCount = 0;
    let lastInputProtectionLogAt = 0;

    function yieldToInput(): Promise<void> {
        return new Promise((resolve) => window.setTimeout(resolve, isTextInputFocused() ? 16 : 0));
    }

    function noteInputDeferral(): void {
        inputDeferredRenderCount++;
        if (inputDeferredAt === 0) inputDeferredAt = performance.now();
    }

    function logCompletedInputDeferral(): void {
        if (inputDeferredAt === 0) return;
        const now = performance.now();
        const durationMs = Math.round(now - inputDeferredAt);
        if (durationMs >= 300 && now - lastInputProtectionLogAt >= 30_000) {
            lastInputProtectionLogAt = now;
            console.info(`[renderer-diagnostics] ${JSON.stringify({
                event: 'text-input-protection',
                durationMs,
                deferredRenderPasses: inputDeferredRenderCount,
                pendingMessages: pending.length,
                pendingDecodes: decodePending.length
            })}`);
        }
        inputDeferredAt = 0;
        inputDeferredRenderCount = 0;
    }

    function topicMatchesPattern(topic: string, pattern: string): boolean {
        const topicParts = topic.split('/');
        const patternParts = pattern.split('/');
        for (let i = 0; i < patternParts.length; i++) {
            const part = patternParts[i];
            if (part === '#') return i === patternParts.length - 1;
            if (i >= topicParts.length) return false;
            if (part !== '+' && part !== topicParts[i]) return false;
        }
        return topicParts.length === patternParts.length;
    }

    function hasDecoderForTopic(topic: string): boolean {
        const cached = decoderTopicCache.get(topic);
        if (cached !== undefined) return cached;
        let matched = false;
        for (const plugin of plugins.enabledPlugins) {
            if (!plugin.hasDecoder) continue;
            const patterns = plugin.manifest.topicPatterns;
            if (!patterns?.length || patterns.some((pattern) => topicMatchesPattern(topic, pattern))) {
                matched = true;
                break;
            }
        }
        if (!decoderTopicCache.has(topic) && decoderTopicCache.size >= 20_000) {
            const oldest = decoderTopicCache.keys().next().value;
            if (oldest != null) decoderTopicCache.delete(oldest);
        }
        decoderTopicCache.set(topic, matched);
        return matched;
    }

    function adaptiveRenderDelay(): number {
        const busyRemaining = textInputBusyRemainingMs();
        if (busyRemaining > 0) return Math.max(RENDER_INPUT_DELAY_MS, Math.ceil(busyRemaining));
        if (isTextInputFocused()) return RENDER_INPUT_DELAY_MS;
        if (pending.length > RENDER_BATCH_LIMIT * 4) return RENDER_BACKLOG_DELAY_MS;
        if (renderCostEma > 12) return RENDER_SLOW_DELAY_MS;
        return 0;
    }

    function adaptiveRenderLimit(): number {
        if (isTextInputFocused()) return RENDER_INPUT_BATCH_LIMIT;
        if (pending.length > RENDER_BATCH_LIMIT * 4) return RENDER_BACKLOG_BATCH_LIMIT;
        return RENDER_BATCH_LIMIT;
    }

    function drainPendingConnection(connectionId: string): void {
        if (!pending.some((item) => item.connectionId === connectionId)) return;
        const selected: MqttMessage[] = [];
        const remaining: MqttMessage[] = [];
        for (const item of pending) {
            if (item.connectionId === connectionId) selected.push(item);
            else remaining.push(item);
        }
        pending.length = 0;
        pending.push(...remaining);
        const rows = msg.ingest(connectionId, selected);
        enqueueDecodeRows(connectionId, rows);
    }

    async function hydrateActiveConnection(connectionId: string): Promise<void> {
        const token = ++activeHydrateToken;
        try {
            const limit = Math.min(50_000, msg.bucketFor(connectionId).timeline.capacity);
            const recent = await window.api.mqttReadRecent({ connectionId, limit });
            if (token !== activeHydrateToken || conn.selectedId !== connectionId || msg.bucketFor(connectionId).paused) return;
            if (!recent.success || !recent.data) return;
            // 先把已抵达 renderer、但尚未 RAF flush 的同连接消息原子落入 store，
            // 再按快照出现次数差额补齐，避免 pending 与 recent 重复。
            drainPendingConnection(connectionId);
            const additions = msg.mergeRecentSnapshot(connectionId, recent.data.rows);
            hydrationCredits.set(connectionId, createHydrationCredits(recent.data.throughTime, additions));
        } catch (error) {
            if (import.meta.env.DEV) console.warn('[hydrate recent]', error);
        }
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
            if (!hasDecoderForTopic(row.topic)) continue;
            decodePending.push({ connectionId, topic: row.topic, row });
        }
        if (decodePending.length > DECODE_QUEUE_LIMIT) {
            decodePending.splice(0, decodePending.length - DECODE_QUEUE_LIMIT);
        }
        scheduleDecode();
    }

    function scheduleDecode(): void {
        if (decoding || decodeTimer != null || decodePending.length === 0) return;
        const busyRemaining = textInputBusyRemainingMs();
        decodeTimer = window.setTimeout(() => {
            decodeTimer = null;
            void runDecodeQueue();
        }, busyRemaining > 0
            ? Math.max(DECODE_INPUT_DELAY_MS, Math.ceil(busyRemaining))
            : isTextInputFocused() ? DECODE_INPUT_DELAY_MS : 0);
    }

    async function runDecodeQueue(): Promise<void> {
        if (decoding || decodePending.length === 0) return;
        if (isTextInputBusy()) {
            scheduleDecode();
            return;
        }
        decoding = true;
        const generation = decodeGeneration;
        try {
            while (decodePending.length > 0 && generation === decodeGeneration) {
                if (isTextInputBusy()) break;
                const selectedConnection = conn.selectedId;
                if (!selectedConnection) {
                    decodePending.length = 0;
                    return;
                }
                const decodeLimit = isTextInputFocused() ? DECODE_INPUT_BATCH_LIMIT : DECODE_BATCH_LIMIT;
                const batch = decodePending
                    .splice(0, decodeLimit)
                    .filter((item) => item.connectionId === selectedConnection);
                if (batch.length === 0) continue;
                const decodeStartedAt = performance.now();
                const result = await window.api.pluginDecodeBatch(
                    batch.map((item) => ({ topic: item.topic, payload: item.row.payload }))
                );
                recordRendererPerf('mqtt.decode-batch', performance.now() - decodeStartedAt, batch.length);
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
        if (isTextInputBusy()) {
            noteInputDeferral();
            schedule();
            return;
        }
        logCompletedInputDeferral();
        const startedAt = performance.now();
        let flushedCount = 0;
        flushing = true;
        try {
            const byConn = new Map<string, MqttMessage[]>();
            const renderLimit = adaptiveRenderLimit();
            const batch = pending.splice(0, Math.min(pending.length, renderLimit));
            flushedCount = batch.length;
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
            const cost = performance.now() - startedAt;
            recordRendererPerf('mqtt.render-flush', cost, flushedCount);
            renderCostEma = renderCostEma === 0 ? cost : renderCostEma * 0.8 + cost * 0.2;
            flushing = false;
            if (pending.length > 0) schedule();
        }
    }

    function schedule(): void {
        if (rafId != null || renderTimer != null) return;
        const delay = adaptiveRenderDelay();
        if (delay > 0) {
            renderTimer = window.setTimeout(() => {
                renderTimer = null;
                if (isTextInputBusy()) {
                    noteInputDeferral();
                    schedule();
                    return;
                }
                rafId = requestAnimationFrame(async () => {
                    rafId = null;
                    await flush();
                });
            }, delay);
            return;
        }
        rafId = requestAnimationFrame(async () => {
            rafId = null;
            await flush();
        });
    }

    function start(): void {
        stopInputActivityTracking = installTextInputActivityTracking();
        stopPluginWatch = watch(() => plugins.list, () => decoderTopicCache.clear());
        unsubMsg = window.api.onMqttMessages((batch) => {
            if (!batch.length) return;
            const visibleBatch = batch.filter((item) => {
                if (!item.connectionId) return false;
                const ledger = hydrationCredits.get(item.connectionId);
                const suppress = consumeHydrationCredit(ledger, item);
                if (ledger && (ledger.counts.size === 0 || item.time > ledger.cutoff)) {
                    hydrationCredits.delete(item.connectionId);
                }
                return !suppress;
            });
            if (!visibleBatch.length) return;
            if (import.meta.env.DEV) {
                const connIds = new Set(visibleBatch.map((item) => item.connectionId).filter(Boolean));
                console.debug('[mqtt] batch:', [...connIds].join(','), visibleBatch.length, visibleBatch[0]?.topic);
            }
            pending.push(...visibleBatch);
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
                for (const connectionId of hydrationCredits.keys()) {
                    if (connectionId !== cid) hydrationCredits.delete(connectionId);
                }
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
        stopInputActivityTracking?.();
        stopInputActivityTracking = null;
        stopPluginWatch?.();
        stopPluginWatch = null;
        decoderTopicCache.clear();
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
        hydrationCredits.clear();
    }

    return { start, stop };
}
