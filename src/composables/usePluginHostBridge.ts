import { useConnectionStore } from '@/stores/connection';
import { useMessageStore } from '@/stores/messages';
import { useParamMemory } from '@/composables/useParamMemory';

declare global {
    interface Window {
        __MM_PLUGIN_HOST_BRIDGE__?: {
            getSnapshot: () => {
                selectedConnectionId: string | null;
                selectedConnectionState: string;
                connections: Array<{ id: string; name: string; state: string }>;
                messages: any[];
                publishHistory: any[];
                paramSuggestions: Record<string, string[]>;
            };
            publish: (p: { connectionId?: string; topic: string; payload: string; qos?: 0 | 1 | 2; retain?: boolean }) => Promise<{
                success: boolean;
                message?: string;
                time?: number;
            }>;
        };
    }
}

export function installPluginHostBridge(): () => void {
    const conn = useConnectionStore();
    const msg = useMessageStore();
    const paramMem = useParamMemory();

    window.__MM_PLUGIN_HOST_BRIDGE__ = {
        getSnapshot() {
            const selectedConnectionId = conn.selectedId;
            const bucket = msg.bucketFor(selectedConnectionId);
            return {
                selectedConnectionId,
                selectedConnectionState: conn.selectedState,
                connections: conn.list.map((item) => ({
                    id: item.id,
                    name: item.name,
                    state: conn.states[item.id]?.state ?? 'idle'
                })),
                messages: bucket.timeline.snapshot(),
                publishHistory: bucket.publishHistory.snapshot(),
                paramSuggestions: {
                    sn: paramMem.suggestionsFor('sn'),
                    airportSn: paramMem.suggestionsFor('airportSn'),
                    gateway: paramMem.suggestionsFor('gateway'),
                    droneSn: paramMem.suggestionsFor('droneSn')
                }
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
        }
    };

    return () => {
        delete window.__MM_PLUGIN_HOST_BRIDGE__;
    };
}
