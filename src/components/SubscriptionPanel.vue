<script setup lang="ts">
import { ref, computed } from 'vue';
import { useConnectionStore } from '@/stores/connection';
import { useToast } from '@/composables/useToast';
import { useUiPrefs } from '@/composables/useUiPrefs';
import { useSubscriptionSync } from '@/composables/useSubscriptionSync';
import type { SubscriptionConfig } from '@shared/types';

const conn = useConnectionStore();
const toast = useToast();
const { prefs, toggleRight } = useUiPrefs();
const { sync } = useSubscriptionSync();
const topic = ref('test/#');
const qos = ref<0 | 1 | 2>(0);
const isOpen = computed(() => prefs.activeRight === 'sub');

const selected = computed(() => conn.selected);
const canOp = computed(() => conn.selectedState === 'connected');

async function doSubscribe(): Promise<void> {
    const c = selected.value;
    if (!c) return;
    const t = topic.value.trim();
    if (!t) { toast.error('主题不能为空'); return; }
    if (!canOp.value) { toast.error('请先连接'); return; }

    // 已存在（等同 filter 已订阅过），保持幂等
    const existing = c.subscriptions.find((s) => s.topic === t);
    if (existing) { toast.info(`已经订阅过：${t}`); return; }

    // 本地先加；broker 层由 sync 决定是否真的下发 / 取消被覆盖的
    conn.addSubscription(c.id, { topic: t, qos: qos.value, paused: false });
    await sync(c, canOp.value);
    toast.success(`订阅成功：${t}`);
}

async function doUnsubscribe(t: string): Promise<void> {
    const c = selected.value;
    if (!c) return;
    conn.removeSubscription(c.id, t);
    await sync(c, canOp.value);
}

async function togglePause(s: SubscriptionConfig): Promise<void> {
    const c = selected.value;
    if (!c) return;
    const next = !s.paused;
    conn.setSubscriptionPaused(c.id, s.topic, next);
    await sync(c, canOp.value);
    toast.info(next ? `已暂停：${s.topic}` : `已恢复：${s.topic}`);
}

async function pauseAll(): Promise<void> {
    const c = selected.value;
    if (!c) return;
    for (const s of c.subscriptions) if (!s.paused) conn.setSubscriptionPaused(c.id, s.topic, true);
    await sync(c, canOp.value);
}
async function resumeAll(): Promise<void> {
    const c = selected.value;
    if (!c) return;
    for (const s of c.subscriptions) if (s.paused) conn.setSubscriptionPaused(c.id, s.topic, false);
    await sync(c, canOp.value);
}

const hasActive = computed(() => (selected.value?.subscriptions ?? []).some((s) => !s.paused));
const hasPaused = computed(() => (selected.value?.subscriptions ?? []).some((s) => s.paused));

/** 排序后的订阅列表：未暂停的在上，已暂停的在下，组内保持原插入顺序 */
const orderedSubs = computed<SubscriptionConfig[]>(() => {
    const raw = selected.value?.subscriptions ?? [];
    const active = raw.filter((s) => !s.paused);
    const paused = raw.filter((s) => s.paused);
    return [...active, ...paused];
});
</script>

<template>
    <section class="panel" :class="{ open: isOpen }">
        <div class="panel-head clickable" @click="toggleRight('sub')">
            <h2>📬 订阅管理</h2>
            <span class="pill" v-if="selected">{{ (selected.subscriptions ?? []).length }}</span>
            <span class="spacer"></span>
            <button v-if="isOpen && hasActive" class="btn btn-mini" :disabled="!canOp" @click.stop="pauseAll" title="暂停全部">⏸️ 全部</button>
            <button v-if="isOpen && hasPaused" class="btn btn-mini" :disabled="!canOp" @click.stop="resumeAll" title="恢复全部">▶️ 全部</button>
            <span class="chev">{{ isOpen ? '▾' : '▸' }}</span>
        </div>
        <div v-if="isOpen" class="panel-body">
            <div class="row">
                <div class="field" style="flex: 1">
                    <label>主题</label>
                    <input v-model="topic" placeholder="test/#" @keydown.enter="doSubscribe" />
                </div>
                <div class="field" style="width: 80px">
                    <label>QoS</label>
                    <select v-model.number="qos">
                        <option :value="0">0</option>
                        <option :value="1">1</option>
                        <option :value="2">2</option>
                    </select>
                </div>
                <button class="btn btn-success" :disabled="!canOp" @click="doSubscribe">订阅</button>
            </div>

            <div class="list">
                <div v-if="!selected || selected.subscriptions.length === 0" class="empty">暂无订阅</div>
                <div
                    v-for="s in orderedSubs"
                    :key="s.topic"
                    class="item"
                    :class="{ paused: s.paused }"
                >
                    <span class="pill">QoS {{ s.qos }}</span>
                    <span class="t">{{ s.topic }}</span>
                    <span v-if="s.paused" class="tag-paused">已暂停</span>
                    <button
                        class="btn btn-mini btn-ghost"
                        :disabled="!canOp"
                        :title="s.paused ? '恢复接收' : '暂停接收'"
                        @click="togglePause(s)"
                    >{{ s.paused ? '▶️' : '⏸️' }}</button>
                    <button class="btn btn-mini btn-ghost" @click="doUnsubscribe(s.topic)" title="移除订阅">🗑️</button>
                </div>
            </div>
        </div>
    </section>
</template>

<style lang="scss" scoped>
.panel-head.clickable {
    cursor: pointer;
    user-select: none;
    &:hover {
        background: var(--card-hover-bg);
    }
    .chev {
        color: var(--text-3);
        font-size: 12px;
        margin-left: 6px;
    }
}

.row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
}
.list {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 7px 10px;
    background: var(--card-bg);
    border-radius: 6px;
    border: 1px solid var(--border);
    transition: opacity 0.15s, background 0.15s;

    &.paused {
        opacity: 0.55;
        background: rgba(245, 158, 11, 0.05);
        border-color: rgba(245, 158, 11, 0.25);
    }

    .pill,
    .tag-paused,
    .btn {
        flex: 0 0 auto;
        margin-top: 1px;
    }

    .t {
        flex: 1;
        min-width: 0;
        font-family: 'JetBrains Mono', Consolas, monospace;
        font-size: 12px;
        color: var(--text-0);
        line-height: 1.45;
        word-break: break-all;
        white-space: pre-wrap;
        user-select: text;
        cursor: text;
    }

    .tag-paused {
        padding: 1px 7px;
        font-size: 10px;
        border-radius: 4px;
        background: rgba(245, 158, 11, 0.25);
        color: #fbbf24;
        font-weight: 600;
        letter-spacing: 0.4px;
    }

    .btn.btn-ghost {
        opacity: 0.5;
        padding: 3px 7px;
    }
    &:hover .btn.btn-ghost {
        opacity: 1;
    }
}
</style>
