<script setup lang="ts">
import { ref, computed } from 'vue';
import { useConnectionStore } from '@/stores/connection';
import { useToast } from '@/composables/useToast';
import { useUiPrefs } from '@/composables/useUiPrefs';
import type { SubscriptionConfig } from '@shared/types';

const conn = useConnectionStore();
const toast = useToast();
const { prefs } = useUiPrefs();
const topic = ref('test/#');
const qos = ref<0 | 1 | 2>(0);

const selected = computed(() => conn.selected);
const canOp = computed(() => conn.selectedState === 'connected');

async function doSubscribe(): Promise<void> {
    const c = selected.value;
    if (!c) return;
    const t = topic.value.trim();
    if (!t) { toast.error('主题不能为空'); return; }
    if (!canOp.value) { toast.error('请先连接'); return; }
    const r = await window.api.mqttSubscribe({ connectionId: c.id, topic: t, qos: qos.value });
    if (import.meta.env.DEV) console.debug('[mqtt] subscribe result:', t, r);
    if (r.success) {
        conn.addSubscription(c.id, { topic: t, qos: qos.value, paused: false });
        toast.success(`订阅成功：${t}`);
    } else {
        toast.error('订阅失败：' + (r.message || ''));
    }
}

async function doUnsubscribe(t: string): Promise<void> {
    const c = selected.value;
    if (!c) return;
    if (canOp.value) await window.api.mqttUnsubscribe({ connectionId: c.id, topic: t });
    conn.removeSubscription(c.id, t);
}

async function togglePause(s: SubscriptionConfig): Promise<void> {
    const c = selected.value;
    if (!c) return;
    const next = !s.paused;
    if (canOp.value) {
        if (next) {
            const r = await window.api.mqttUnsubscribe({ connectionId: c.id, topic: s.topic });
            if (!r.success) {
                toast.error('暂停失败：' + (r.message || ''));
                return;
            }
        } else {
            const r = await window.api.mqttSubscribe({ connectionId: c.id, topic: s.topic, qos: s.qos });
            if (!r.success) {
                toast.error('恢复失败：' + (r.message || ''));
                return;
            }
        }
    }
    conn.setSubscriptionPaused(c.id, s.topic, next);
    toast.info(next ? `已暂停：${s.topic}` : `已恢复：${s.topic}`);
}

async function pauseAll(): Promise<void> {
    const c = selected.value;
    if (!c) return;
    for (const s of [...c.subscriptions]) {
        if (!s.paused) await togglePause(s);
    }
}
async function resumeAll(): Promise<void> {
    const c = selected.value;
    if (!c) return;
    for (const s of [...c.subscriptions]) {
        if (s.paused) await togglePause(s);
    }
}

const hasActive = computed(() => (selected.value?.subscriptions ?? []).some((s) => !s.paused));
const hasPaused = computed(() => (selected.value?.subscriptions ?? []).some((s) => s.paused));
</script>

<template>
    <section class="panel" :class="{ collapsed: !prefs.subOpen }">
        <div class="panel-head clickable" @click="prefs.subOpen = !prefs.subOpen">
            <h2>📬 订阅管理</h2>
            <span class="pill" v-if="selected">{{ (selected.subscriptions ?? []).length }}</span>
            <span class="spacer"></span>
            <button v-if="prefs.subOpen && hasActive" class="btn btn-mini" :disabled="!canOp" @click.stop="pauseAll" title="暂停全部">⏸️ 全部</button>
            <button v-if="prefs.subOpen && hasPaused" class="btn btn-mini" :disabled="!canOp" @click.stop="resumeAll" title="恢复全部">▶️ 全部</button>
            <span class="chev">{{ prefs.subOpen ? '▾' : '▸' }}</span>
        </div>
        <div v-if="prefs.subOpen" class="panel-body">
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
                    v-for="s in selected?.subscriptions ?? []"
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
    max-height: 220px;
    overflow-y: auto;
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
