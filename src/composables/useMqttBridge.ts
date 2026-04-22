import { watch } from 'vue';
import { useConnectionStore, type ConnState } from '@/stores/connection';
import { useMessageStore } from '@/stores/messages';
import type { MqttMessage } from '@shared/types';

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

    const pendingBatches: MqttMessage[][] = [];
    let rafId: number | null = null;

    function schedule(): void {
        if (rafId != null) return;
        rafId = requestAnimationFrame(() => {
            rafId = null;
            if (!pendingBatches.length) return;
            let total = 0;
            for (const b of pendingBatches) total += b.length;
            const merged = new Array<MqttMessage>(total);
            let k = 0;
            for (const b of pendingBatches) for (let i = 0; i < b.length; i++) merged[k++] = b[i];
            pendingBatches.length = 0;
            if (!msg.paused) msg.ingest(merged);
            else msg.ingest(merged); // 暂停时也写入 store（保证计数/历史同步），UI 侧通过 paused 冻结刷新
        });
    }

    function start(): void {
        unsubMsg = window.api.onMqttMessages((batch) => {
            if (import.meta.env.DEV) {
                console.debug('[mqtt] batch:', batch.length, batch[0]?.topic);
            }
            pendingBatches.push(batch);
            schedule();
        });

        unsubState = window.api.onMqttState((p) => {
            if (import.meta.env.DEV) {
                console.debug('[mqtt] state:', p.connectionId, p.state, p.message);
            }
            conn.setState(p.connectionId, p.state as ConnState, p.message);
        });

        // 选中变化 → 把选中主题作为 priorityTopic 通知主进程
        stopWatch = watch(
            () => msg.selectedTopic,
            (topic) => {
                const cid = conn.selectedId;
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
        pendingBatches.length = 0;
    }

    return { start, stop };
}
