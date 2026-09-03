import { reactive, readonly } from 'vue';
import { useToast } from '@/composables/useToast';
import { rewriteReplayPayloadTimestamps, type ReplayMessage, type ReplayTimestampRewrite } from '@/utils/replay';

export type ReplaySpeed = 'instant' | '1x' | '2x' | '5x' | '10x';

export interface ReplayRunOptions {
    connectionId: string;
    rows: ReplayMessage[];
    speed: ReplaySpeed;
    loop?: boolean;
    /** 将每条 JSON payload 内形似 Unix 时间的数字改为当前时间（毫秒或秒） */
    timestampRewrite?: ReplayTimestampRewrite;
}

interface ReplayState {
    running: boolean;
    paused: boolean;
    connectionId: string | null;
    sourceName: string;
    total: number;
    sent: number;
    failed: number;
    startedAt: number;
    lastError: string;
    stopRequested: boolean;
    loopEnabled: boolean;
    rounds: number;
    currentIndex: number;
    currentTopic: string;
    currentTime: number;
}

const state = reactive<ReplayState>({
    running: false,
    paused: false,
    connectionId: null,
    sourceName: '',
    total: 0,
    sent: 0,
    failed: 0,
    startedAt: 0,
    lastError: '',
    stopRequested: false,
    loopEnabled: false,
    rounds: 0,
    currentIndex: -1,
    currentTopic: '',
    currentTime: 0
});

const speedMap: Record<ReplaySpeed, number> = {
    instant: 0,
    '1x': 1,
    '2x': 2,
    '5x': 5,
    '10x': 10
};

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitIfPaused(): Promise<void> {
    while (state.paused && !state.stopRequested) {
        await sleep(120);
    }
}

async function waitForDelta(prev: ReplayMessage, next: ReplayMessage, speed: ReplaySpeed): Promise<void> {
    const factor = speedMap[speed];
    if (factor <= 0) return;
    const delta = Math.max(0, next.time - prev.time);
    if (delta <= 0) return;
    let remaining = Math.min(60_000, Math.round(delta / factor));
    while (remaining > 0 && !state.stopRequested) {
        await waitIfPaused();
        if (state.stopRequested) return;
        const chunk = Math.min(remaining, 200);
        await sleep(chunk);
        remaining -= chunk;
    }
}

export function useMqttReplay() {
    const toast = useToast();

    async function start(sourceName: string, options: ReplayRunOptions): Promise<void> {
        if (state.running) throw new Error('已有回放任务正在运行');
        if (!options.rows.length) throw new Error('没有可回放的数据');

        state.running = true;
        state.paused = false;
        state.connectionId = options.connectionId;
        state.sourceName = sourceName;
        state.total = options.rows.length;
        state.sent = 0;
        state.failed = 0;
        state.startedAt = Date.now();
        state.lastError = '';
        state.stopRequested = false;
        state.loopEnabled = !!options.loop;
        state.rounds = 0;
        state.currentIndex = -1;
        state.currentTopic = '';
        state.currentTime = 0;

        try {
            do {
                state.rounds++;
                for (let i = 0; i < options.rows.length; i++) {
                    if (state.stopRequested) break;
                    await waitIfPaused();
                    if (state.stopRequested) break;
                    const row = options.rows[i];
                    if (i > 0) {
                        await waitForDelta(options.rows[i - 1], row, options.speed);
                        if (state.stopRequested) break;
                        await waitIfPaused();
                        if (state.stopRequested) break;
                    }
                    // 等待节奏结束后才更新“当前消息”，避免预览提前显示尚未发布的行。
                    state.currentIndex = i;
                    state.currentTopic = row.topic;
                    state.currentTime = row.time;
                    const tw = options.timestampRewrite ?? 'off';
                    const payload = rewriteReplayPayloadTimestamps(row.payload, tw);
                    const result = await window.api.mqttPublish({
                        connectionId: options.connectionId,
                        topic: row.topic,
                        payload,
                        qos: row.qos,
                        retain: row.retain
                    });
                    if (result.success) {
                        state.sent++;
                    } else {
                        state.failed++;
                        state.lastError = result.message || '发布失败';
                    }
                }
            } while (options.loop && !state.stopRequested);

            if (state.stopRequested) {
                toast.info(`已停止回放：${state.sent}/${state.total}`);
            } else if (state.failed > 0) {
                toast.warning(`回放完成，成功 ${state.sent} 条，失败 ${state.failed} 条`);
            } else {
                toast.success(`回放完成：${state.sent} 条`);
            }
        } finally {
            state.running = false;
            state.paused = false;
            state.stopRequested = false;
            state.currentIndex = -1;
            state.currentTopic = '';
            state.currentTime = 0;
        }
    }

    function stop(): void {
        if (!state.running) return;
        state.stopRequested = true;
    }

    function togglePause(): void {
        if (!state.running) return;
        state.paused = !state.paused;
    }

    return {
        state: readonly(state),
        start,
        stop,
        togglePause
    };
}
