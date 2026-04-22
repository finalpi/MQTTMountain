import { watch } from 'vue';
import { useConnectionStore, type ConnState } from '@/stores/connection';
import { useMessageStore } from '@/stores/messages';
import type { MqttMessage } from '@shared/types';

interface PendingItem { connId: string; batch: MqttMessage[] }

/**
 * 桥接主进程批量消息 → 渲染侧 store。
 * 收到一批消息后用 requestAnimationFrame 合并，避免每批都触发响应式刷新。
 */
export function useMqttBridge() {
    const conn = useConnectionStore();
    const msg = useMessageStore();
    let unsubMsg: (() => void) | null = null;
    let unsubState: (() => void) | null = null;
    let stopWatch: (() => void) | null = null;

    const pending: PendingItem[] = [];
    let rafId: number | null = null;

    function schedule(): void {
        if (rafId != null) return;
        rafId = requestAnimationFrame(() => {
            rafId = null;
            if (!pending.length) return;

            // 按 connectionId 聚合，分别投递到各自的 bucket
            const byConn = new Map<string, MqttMessage[]>();
            for (const it of pending) {
                let arr = byConn.get(it.connId);
                if (!arr) { arr = []; byConn.set(it.connId, arr); }
                for (let i = 0; i < it.batch.length; i++) arr.push(it.batch[i]);
            }
            pending.length = 0;

            for (const [connId, list] of byConn) {
                msg.ingest(connId, list);
            }
        });
    }

    function start(): void {
        unsubMsg = window.api.onMqttMessages((batch) => {
            if (!batch.length) return;
            // 同一批次里的所有消息都是同一 connectionId（主进程按连接分离），取第一条即可
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

        // 选中连接 / 选中主题变化时告知主进程当前关注主题，降采样保护它
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
        unsubMsg?.(); unsubMsg = null;
        unsubState?.(); unsubState = null;
        stopWatch?.(); stopWatch = null;
        if (rafId != null) cancelAnimationFrame(rafId);
        rafId = null;
        pending.length = 0;
    }

    return { start, stop };
}
