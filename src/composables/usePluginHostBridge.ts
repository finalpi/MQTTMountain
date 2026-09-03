import { useConnectionStore } from '@/stores/connection';
import { useMessageStore, type MsgRow } from '@/stores/messages';
import { useParamMemory } from '@/composables/useParamMemory';
import { recordRendererPerf } from '@/utils/rendererPerf';
import { buildIncrementalSnapshot } from '@/utils/incrementalSnapshot';

interface PluginSnapshotOptions {
    messageLimit?: number;
    publishLimit?: number;
    includeParamSuggestions?: boolean;
    afterMessageSeq?: number;
    messageEpoch?: number;
}

interface PluginBridgeStats {
    calls: number;
    lastLogAt: number;
}

declare global {
    interface Window {
        __MM_PLUGIN_HOST_BRIDGE__?: {
            getVersion: () => {
                selectedConnectionId: string | null;
                selectedConnectionState: string;
                timelineVersion: number;
                publishHistoryVersion: number;
                receiveCount: number;
                publishCount: number;
                paramSuggestionsVersion: number;
                messageEpoch: number;
            };
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
                messageMode: 'full' | 'delta';
                messageEpoch: number;
                oldestMessageSeq: number | null;
                latestMessageSeq: number | null;
            };
            publish: (p: { connectionId?: string; topic: string; payload: string; qos?: 0 | 1 | 2; retain?: boolean; recordHistory?: boolean }) => Promise<{
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
    let cachedParamSuggestionsVersion = -1;
    let cachedParamSuggestions: Record<string, string[]> = {};
    let cachedPublishKey = '';
    let cachedPublishRows: any[] = [];

    function paramSuggestionsSnapshot(): Record<string, string[]> {
        if (cachedParamSuggestionsVersion === paramMem.version) return cachedParamSuggestions;
        const out: Record<string, string[]> = {};
        for (const [key, values] of Object.entries(paramMem.state.data)) {
            out[key] = Object.freeze(values.slice()) as unknown as string[];
        }
        cachedParamSuggestionsVersion = paramMem.version;
        cachedParamSuggestions = Object.freeze(out);
        return cachedParamSuggestions;
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

    function publishSnapshot(connectionId: string | null, bucket: ReturnType<typeof msg.bucketFor>, limit: number): any[] {
        const key = `${connectionId ?? ''}:${bucket.publishHistoryVersion}:${limit}`;
        if (key === cachedPublishKey) return cachedPublishRows;
        cachedPublishKey = key;
        cachedPublishRows = Object.freeze(ringSnapshotLatest(bucket.publishHistory, limit)) as unknown as any[];
        return cachedPublishRows;
    }

    function maybeLogSnapshotRead(messageLimit: number, publishLimit: number): void {
        bridgeStats.calls++;
        const now = Date.now();
        if (now - bridgeStats.lastLogAt < 60_000) return;
        bridgeStats.lastLogAt = now;
        const mem = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
        console.info(`[plugin-bridge] snapshot reads ${JSON.stringify({
            calls: bridgeStats.calls,
            hasSelectedConnection: Boolean(conn.selectedId),
            messageLimit,
            publishLimit,
            rendererHeapMb: mem?.usedJSHeapSize ? Math.round(mem.usedJSHeapSize / 1024 / 1024) : undefined
        })}`);
        bridgeStats.calls = 0;
    }

    window.__MM_PLUGIN_HOST_BRIDGE__ = {
        getVersion() {
            const selectedConnectionId = conn.selectedId;
            const bucket = msg.bucketFor(selectedConnectionId);
            return {
                selectedConnectionId,
                selectedConnectionState: conn.selectedState,
                timelineVersion: bucket.timelineVersion,
                publishHistoryVersion: bucket.publishHistoryVersion,
                receiveCount: bucket.receiveCount,
                publishCount: bucket.publishCount,
                paramSuggestionsVersion: paramMem.version,
                messageEpoch: bucket.messageEpoch
            };
        },
        getSnapshot(options = {}) {
            const startedAt = performance.now();
            const selectedConnectionId = conn.selectedId;
            const bucket = msg.bucketFor(selectedConnectionId);
            const messageLimit = normalizeLimit(options.messageLimit, bucket.timeline.length, bucket.timeline.length);
            const publishLimit = normalizeLimit(options.publishLimit, bucket.publishHistory.length, bucket.publishHistory.length);
            maybeLogSnapshotRead(messageLimit, publishLimit);
            const messages = buildIncrementalSnapshot<MsgRow>(
                bucket.timeline,
                messageLimit,
                bucket.messageEpoch,
                options.messageEpoch,
                options.afterMessageSeq
            );
            const snapshot = {
                selectedConnectionId,
                selectedConnectionState: conn.selectedState,
                connections: conn.list.map((item) => ({
                    id: item.id,
                    name: item.name,
                    state: conn.states[item.id]?.state ?? 'idle'
                })),
                messages: messages.rows,
                publishHistory: publishSnapshot(selectedConnectionId, bucket, publishLimit),
                paramSuggestions: options.includeParamSuggestions === false ? {} : paramSuggestionsSnapshot(),
                timelineVersion: bucket.timelineVersion,
                publishHistoryVersion: bucket.publishHistoryVersion,
                receiveCount: bucket.receiveCount,
                publishCount: bucket.publishCount,
                messageMode: messages.mode,
                messageEpoch: bucket.messageEpoch,
                oldestMessageSeq: messages.oldestSeq,
                latestMessageSeq: messages.latestSeq
            };
            recordRendererPerf(
                `plugin.snapshot-${messages.mode}`,
                performance.now() - startedAt,
                snapshot.messages.length + snapshot.publishHistory.length
            );
            return snapshot;
        },
        async publish(p) {
            const connectionId = p.connectionId || conn.selectedId || '';
            if (!connectionId) return { success: false, message: '未选择连接' };
            if (!p.topic?.trim()) return { success: false, message: '发布主题不能为空' };
            if (/[+#]/u.test(p.topic)) return { success: false, message: '发布主题不能包含通配符' };
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
            if (p.recordHistory === false) return { success: true, time };
            msg.pushPublishHistory(connectionId, item);
            try {
                const history = await window.api.publishHistoryAppend({ connectionId, ...item });
                return history.success
                    ? { success: true, time }
                    : { success: true, time, message: `消息已发送，但历史保存失败：${history.message || '未知错误'}` };
            } catch (error) {
                return {
                    success: true,
                    time,
                    message: `消息已发送，但历史保存失败：${error instanceof Error ? error.message : String(error)}`
                };
            }
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
