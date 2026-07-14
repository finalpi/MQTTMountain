import { useConnectionStore } from '@/stores/connection';
import { useMessageStore } from '@/stores/messages';
import { useParamMemory } from '@/composables/useParamMemory';

interface PluginSnapshotOptions {
    messageLimit?: number;
    publishLimit?: number;
    includeParamSuggestions?: boolean;
}

interface PluginBridgeStats {
    calls: number;
    lastLogAt: number;
}

declare global {
    interface Window {
        __MM_PLUGIN_HOST_BRIDGE__?: {
            getSnapshot: (options?: PluginSnapshotOptions) => {
                selectedConnectionId: string | null;
                selectedConnectionState: string;
                connections: Array<{ id: string; name: string; state: string }>;
                messages: any[];
                publishHistory: any[];
                paramSuggestions: Record<string, string[]>;
                timelineVersion: number;
                publishHistoryVersion: number;
                receiveCount: number;
                publishCount: number;
            };
            publish: (p: { connectionId?: string; topic: string; payload: string; qos?: 0 | 1 | 2; retain?: boolean }) => Promise<{
                success: boolean;
                message?: string;
                time?: number;
            }>;
            rememberParams: (values: Record<string, unknown>) => void;
            setParamSuggestions: (values: Record<string, unknown[]>) => void;
        };
    }
}

export function installPluginHostBridge(): () => void {
    const conn = useConnectionStore();
    const msg = useMessageStore();
    const paramMem = useParamMemory();
    const bridgeStats: PluginBridgeStats = { calls: 0, lastLogAt: 0 };

    function paramSuggestionsSnapshot(): Record<string, string[]> {
        const out: Record<string, string[]> = {};
        for (const [key, values] of Object.entries(paramMem.state.data)) {
            out[key] = values.slice();
        }
        return out;
    }

    function normalizeLimit(value: unknown, fallback: number, max: number): number {
        if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
        return Math.max(0, Math.min(max, Math.floor(value)));
    }

    function ringSnapshotLatest<T>(buffer: { length: number; at: (index: number) => T | undefined; snapshot: () => T[] }, limit: number): T[] {
        if (limit <= 0) return [];
        if (limit >= buffer.length) return buffer.snapshot();
        const start = buffer.length - limit;
        const out = new Array<T>(limit);
        for (let i = 0; i < limit; i++) {
            out[i] = buffer.at(start + i) as T;
        }
        return out;
    }

    function maybeLogSnapshotRead(messageLimit: number, publishLimit: number): void {
        bridgeStats.calls++;
        const now = Date.now();
        if (now - bridgeStats.lastLogAt < 60_000) return;
        bridgeStats.lastLogAt = now;
        const mem = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
        console.info(`[plugin-bridge] snapshot reads ${JSON.stringify({
            calls: bridgeStats.calls,
            selectedConnectionId: conn.selectedId,
            messageLimit,
            publishLimit,
            rendererHeapMb: mem?.usedJSHeapSize ? Math.round(mem.usedJSHeapSize / 1024 / 1024) : undefined
        })}`);
        bridgeStats.calls = 0;
    }

    window.__MM_PLUGIN_HOST_BRIDGE__ = {
        getSnapshot(options = {}) {
            const selectedConnectionId = conn.selectedId;
            const bucket = msg.bucketFor(selectedConnectionId);
            const messageLimit = normalizeLimit(options.messageLimit, bucket.timeline.length, bucket.timeline.length);
            const publishLimit = normalizeLimit(options.publishLimit, bucket.publishHistory.length, bucket.publishHistory.length);
            maybeLogSnapshotRead(messageLimit, publishLimit);
            return {
                selectedConnectionId,
                selectedConnectionState: conn.selectedState,
                connections: conn.list.map((item) => ({
                    id: item.id,
                    name: item.name,
                    state: conn.states[item.id]?.state ?? 'idle'
                })),
                messages: ringSnapshotLatest(bucket.timeline, messageLimit),
                publishHistory: ringSnapshotLatest(bucket.publishHistory, publishLimit),
                paramSuggestions: options.includeParamSuggestions === false ? {} : paramSuggestionsSnapshot(),
                timelineVersion: bucket.timelineVersion,
                publishHistoryVersion: bucket.publishHistoryVersion,
                receiveCount: bucket.receiveCount,
                publishCount: bucket.publishCount
            };
        },
        async publish(p) {
            const connectionId = p.connectionId || conn.selectedId || '';
            if (!connectionId) return { success: false, message: '未选择连接' };
            const time = Date.now();
            const qos = p.qos ?? 1;
            const retain = p.retain ?? false;
            const result = await window.api.mqttPublish({
                connectionId,
                topic: p.topic,
                payload: p.payload,
                qos,
                retain
            });
            if (!result.success) return { success: false, message: result.message };

            const item = {
                topic: p.topic,
                payload: p.payload,
                qos,
                retain,
                time
            };
            msg.pushPublishHistory(connectionId, item);
            await window.api.publishHistoryAppend({ connectionId, ...item });
            return { success: true, time };
        },
        rememberParams(values) {
            for (const [key, value] of Object.entries(values)) {
                if (Array.isArray(value)) {
                    for (let i = value.length - 1; i >= 0; i--) {
                        paramMem.remember(key, value[i]);
                    }
                } else {
                    paramMem.remember(key, value);
                }
            }
        },
        setParamSuggestions(values) {
            for (const [key, list] of Object.entries(values)) {
                paramMem.replaceKey(key, Array.isArray(list) ? list : []);
            }
        }
    };

    return () => {
        delete window.__MM_PLUGIN_HOST_BRIDGE__;
    };
}
