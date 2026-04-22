<script setup lang="ts">
import { computed, ref, watch, onUnmounted, watchEffect, nextTick } from 'vue';
import { useMessageStore, type TopicView, type MsgRow } from '@/stores/messages';
import { useConnectionStore } from '@/stores/connection';
import { useToast } from '@/composables/useToast';
import { useFormatViewer } from '@/composables/useFormatViewer';
import { normalize, highlight } from '@/utils/filter';
import { formatTime, shortTime } from '@/utils/format';
import { exportMqttxJson, exportGroupedZip } from '@/utils/exporter';

const msg = useMessageStore();
const conn = useConnectionStore();
const toast = useToast();
const formatViewer = useFormatViewer();

/** 当前 selected 的连接对应的 bucket（每个连接独立） */
const bucket = computed(() => msg.bucketFor(conn.selectedId));

/** 是否展示消息视图：当前 selected 的连接已 connected（或有历史缓存） */
const hasActiveBucket = computed(() => !!conn.selectedId && msg.hasBucket(conn.selectedId));
const isConnected = computed(() => conn.selectedState === 'connected' || conn.selectedState === 'reconnecting');
const showView = computed(() => isConnected.value || hasActiveBucket.value);

const placeholderTip = computed(() => {
    if (!conn.selectedId) return { emoji: '🔌', title: '还没有选择连接', desc: '请在「📡 连接管理」中选择或新建一个连接' };
    return { emoji: '⚡', title: '该连接未建立', desc: '点击「🔌 连接」查看实时消息，或到「🔍 历史查询」找回已记录数据' };
});

type ViewMode = 'timeline' | 'topic';
const viewMode = ref<ViewMode>('topic');
const filterInput = ref('');
const filterText = ref('');

let filterTimer: number | null = null;
watch(filterInput, (v) => {
    if (filterTimer != null) clearTimeout(filterTimer);
    filterTimer = window.setTimeout(() => (filterText.value = v), 120);
});
onUnmounted(() => { if (filterTimer != null) clearTimeout(filterTimer); });

const normKey = computed(() => normalize(filterText.value));

/** 时间线：按新到旧 */
const timelineList = computed<MsgRow[]>(() => {
    const b = bucket.value;
    void b.timelineVersion;
    const arr = b.timeline.snapshot();
    const nk = normKey.value;
    if (!nk) return arr.slice().reverse();
    const out: MsgRow[] = [];
    for (let i = arr.length - 1; i >= 0; i--) {
        const r = arr[i];
        if ((r.topic + r.payload).replace(/\s+/gu, '').toLowerCase().indexOf(nk) >= 0) out.push(r);
    }
    return out;
});

type TopicSort = 'insert' | 'recent' | 'name' | 'count';
const topicSort = ref<TopicSort>('name');

const topicList = computed<TopicView[]>(() => {
    const b = bucket.value;
    void b.topicsVersion;
    const all: TopicView[] = [];
    const nk = normKey.value;
    for (const v of b.topics.values()) {
        if (nk) {
            let hit = v.normTopic.indexOf(nk) >= 0;
            if (!hit) {
                v.buf.forEachReverse((m) => {
                    if ((m.topic + m.payload).replace(/\s+/gu, '').toLowerCase().indexOf(nk) >= 0) {
                        hit = true;
                        return false;
                    }
                });
            }
            if (!hit) continue;
        }
        all.push(v);
    }
    switch (topicSort.value) {
        case 'recent': all.sort((a, b) => b.lastTime - a.lastTime); break;
        case 'name': all.sort((a, b) => a.topic.localeCompare(b.topic)); break;
        case 'count': all.sort((a, b) => b.total - a.total); break;
        default: break;
    }
    return all;
});

const selectedTopicView = computed<TopicView | null>(() => {
    const b = bucket.value;
    void b.topicsVersion;
    if (!b.selectedTopic) return null;
    return b.topics.get(b.selectedTopic) ?? null;
});

watchEffect(() => {
    const b = bucket.value;
    void b.topicsVersion;
    if (b.selectedTopic) return;
    if (topicList.value.length === 0) return;
    const cid = conn.selectedId;
    if (!cid) return;
    msg.selectTopic(cid, topicList.value[0].topic);
});

const selectedTopicMessages = computed<MsgRow[]>(() => {
    const b = bucket.value;
    void b.topicsVersion;
    const v = selectedTopicView.value;
    if (!v) return [];
    const arr = v.buf.snapshot();
    const nk = normKey.value;
    if (!nk) return arr.slice().reverse();
    const out: MsgRow[] = [];
    for (let i = arr.length - 1; i >= 0; i--) {
        const r = arr[i];
        if ((r.topic + r.payload).replace(/\s+/gu, '').toLowerCase().indexOf(nk) >= 0) out.push(r);
    }
    return out;
});

function setMode(m: ViewMode): void { viewMode.value = m; }

function togglePause(): void {
    const cid = conn.selectedId;
    if (!cid) return;
    msg.setPaused(cid, !bucket.value.paused);
}

async function clearAll(): Promise<void> {
    const cid = conn.selectedId;
    if (!cid) return;
    if (!confirm('清空当前连接的所有消息？（同时会删除本地日志文件）')) return;
    msg.clearAll(cid);
    await window.api.mqttClearLogs(cid);
    toast.success('已清空');
}

async function exportJson(): Promise<void> {
    const rows = bucket.value.timeline.snapshot();
    if (rows.length === 0) { toast.warning('没有消息可导出'); return; }
    exportMqttxJson(rows, `messages-${Date.now()}.json`);
    toast.success(`已导出 ${rows.length} 条`);
}
async function exportZip(): Promise<void> {
    const rows = bucket.value.timeline.snapshot();
    if (rows.length === 0) { toast.warning('没有消息可导出'); return; }
    await exportGroupedZip(rows, `messages-grouped-${Date.now()}.zip`);
    toast.success(`已导出 ${rows.length} 条（按主题分组）`);
}

function selectTopic(t: string): void {
    const cid = conn.selectedId;
    if (!cid) return;
    msg.selectTopic(cid, t);
}
function clearTopic(t: string): void {
    const cid = conn.selectedId;
    if (!cid) return;
    msg.clearTopic(cid, t);
}
function deleteTopic(t: string): void {
    const cid = conn.selectedId;
    if (!cid) return;
    if (!confirm(`删除主题「${t}」及其消息？`)) return;
    msg.removeTopic(cid, t);
}
async function toggleDisable(v: TopicView): Promise<void> {
    const cid = conn.selectedId;
    if (!cid) return;
    const next = !v.disabled;
    msg.setTopicDisabled(cid, v.topic, next);
    conn.toggleDisableTopic(cid, v.topic, next);
    if (next) await window.api.mqttDisableTopic({ connectionId: cid, topic: v.topic });
    else await window.api.mqttEnableTopic({ connectionId: cid, topic: v.topic });
}

// 滚动容器引用与「跟随新消息」
const timelineScrollEl = ref<HTMLElement | null>(null);
const topicScrollEl = ref<HTMLElement | null>(null);
const autoFollow = ref(true);
const showJumpBtn = ref(false);

function currentScroll(): HTMLElement | null {
    return viewMode.value === 'timeline' ? timelineScrollEl.value : topicScrollEl.value;
}

function onUserScroll(): void {
    const el = currentScroll();
    if (!el) return;
    // 用户离开顶部 → 关闭跟随；回到顶部附近 → 恢复跟随
    if (el.scrollTop > 60) {
        if (autoFollow.value) autoFollow.value = false;
        showJumpBtn.value = true;
    } else {
        showJumpBtn.value = false;
        autoFollow.value = true;
    }
}

function scrollToTop(smooth = true): void {
    const el = currentScroll();
    if (!el) return;
    el.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
    autoFollow.value = true;
    showJumpBtn.value = false;
}

// 当消息更新时，若仍处于「跟随」模式则保持在顶部
watch(
    () => [bucket.value.timelineVersion, bucket.value.topicsVersion, bucket.value.selectedTopic, viewMode.value, conn.selectedId] as const,
    async () => {
        if (!autoFollow.value) return;
        await nextTick();
        const el = currentScroll();
        if (el) el.scrollTop = 0;
    }
);

const contextMenu = ref<{ visible: boolean; x: number; y: number; topic: string | null }>({ visible: false, x: 0, y: 0, topic: null });
function openContext(e: MouseEvent, topic: string): void {
    contextMenu.value = { visible: true, x: e.clientX, y: e.clientY, topic };
}
function closeContext(): void {
    contextMenu.value.visible = false;
}
window.addEventListener('click', closeContext);
onUnmounted(() => window.removeEventListener('click', closeContext));
</script>

<template>
    <section class="panel messages">
        <div class="panel-head">
            <div class="mode-toggle">
                <button class="tgl" :class="{ active: viewMode === 'timeline' }" @click="setMode('timeline')">⏱️ 时间线</button>
                <button class="tgl" :class="{ active: viewMode === 'topic' }" @click="setMode('topic')">📑 主题分组</button>
            </div>
            <span class="spacer"></span>
            <button
                class="btn btn-mini"
                :class="bucket.paused ? 'btn-warning' : ''"
                @click="togglePause"
                :title="bucket.paused ? '恢复显示（数据库并未停止记录）' : '暂停显示新消息（主进程仍正常记录到数据库）'"
            >{{ bucket.paused ? '▶️ 恢复' : '⏸️ 暂停' }}</button>
            <button class="btn btn-mini" @click="exportJson" title="导出完整 JSON">📥</button>
            <button class="btn btn-mini" @click="exportZip" title="按主题分组 ZIP">📦</button>
            <button class="btn btn-mini btn-danger" @click="clearAll" title="清空">🗑️</button>
        </div>
        <div class="panel-body">
            <div v-if="!showView" class="mismatch">
                <div class="emoji">{{ placeholderTip.emoji }}</div>
                <div class="title">{{ placeholderTip.title }}</div>
                <div class="desc">{{ placeholderTip.desc }}</div>
            </div>

            <template v-else>
            <div class="filter-row">
                <input v-model="filterInput" placeholder="🔍 过滤主题或内容（忽略空格）..." class="filter-input" />
                <button
                    class="follow-btn"
                    :class="{ active: autoFollow }"
                    :title="autoFollow ? '新消息自动滚动到顶部（点击暂停）' : '恢复跟随新消息'"
                    @click="autoFollow = !autoFollow; if (autoFollow) scrollToTop(false)"
                >📌 {{ autoFollow ? '跟随中' : '已暂停' }}</button>
            </div>

            <div v-if="viewMode === 'timeline'" class="scroll-area bordered" ref="timelineScrollEl" @scroll.passive="onUserScroll">
                <div v-if="timelineList.length === 0" class="empty">暂无消息</div>
                <div v-else class="msg-list">
                    <div
                        v-for="m in timelineList"
                        :key="m.seq"
                        class="msg-card cv-auto"
                        @contextmenu.prevent="formatViewer.open({ topic: m.topic, time: m.time, raw: m.payload })"
                    >
                        <div class="msg-head">
                            <span class="time">{{ formatTime(m.time) }}</span>
                            <span class="topic" v-html="highlight(m.topic, filterText)"></span>
                            <span class="msg-hint">右键格式化</span>
                        </div>
                        <pre class="msg-body" v-html="highlight(m.payload, filterText)"></pre>
                    </div>
                </div>
            </div>

            <div v-else class="split">
                <div class="topic-list">
                    <div class="t-head">
                        <span>主题（{{ topicList.length }}）</span>
                        <select class="sort-select" v-model="topicSort" title="排序方式">
                            <option value="name">主题名</option>
                            <option value="insert">首次出现</option>
                            <option value="recent">最近活跃</option>
                            <option value="count">消息量</option>
                        </select>
                    </div>
                    <div class="scroll-area">
                        <div v-if="topicList.length === 0" class="empty">暂无消息</div>
                        <div v-else class="t-list">
                            <div
                                v-for="t in topicList"
                                :key="t.topic"
                                class="t-item"
                                :class="{ active: bucket.selectedTopic === t.topic, disabled: t.disabled }"
                                @click="selectTopic(t.topic)"
                                @contextmenu.prevent="openContext($event, t.topic)"
                            >
                                <div class="t-name" v-html="highlight(t.topic, filterText)"></div>
                                <div class="t-meta">
                                    <span class="count">{{ t.total }} 条</span>
                                    <span class="ago">{{ shortTime(t.lastTime) }}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="topic-detail">
                    <div class="t-head">
                        <span v-if="selectedTopicView" class="t-head-name" :title="selectedTopicView.topic">{{ selectedTopicView.topic }}</span>
                        <span v-else class="empty">请从左侧选择主题</span>
                    </div>
                    <div v-if="selectedTopicView" class="scroll-area" ref="topicScrollEl" @scroll.passive="onUserScroll">
                        <div v-if="selectedTopicMessages.length === 0" class="empty">该主题暂无消息</div>
                        <div v-else class="msg-list">
                            <div
                                v-for="m in selectedTopicMessages"
                                :key="m.seq"
                                class="msg-card cv-auto"
                                @contextmenu.prevent="formatViewer.open({ topic: m.topic, time: m.time, raw: m.payload })"
                            >
                                <div class="msg-head">
                                    <span class="time">{{ formatTime(m.time) }}</span>
                                    <span class="msg-hint">右键格式化</span>
                                </div>
                                <pre class="msg-body" v-html="highlight(m.payload, filterText)"></pre>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <button v-show="showJumpBtn && !bucket.paused" class="jump-top" @click="scrollToTop()" title="回到顶部查看最新">
                <span>↑ 新消息</span>
            </button>

            <div v-if="bucket.paused" class="paused-banner" title="点击顶部「▶️ 恢复」继续显示新消息">
                <span>⏸️ 已暂停显示新消息 · 主进程仍在记录到数据库</span>
            </div>

            <div v-if="contextMenu.visible" class="ctx" :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }" @click.stop>
                <button @click="clearTopic(contextMenu.topic!); closeContext()">清空该主题消息</button>
                <button @click="toggleDisable(bucket.topics.get(contextMenu.topic!)!); closeContext()">
                    {{ bucket.topics.get(contextMenu.topic!)?.disabled ? '恢复记录' : '禁用记录' }}
                </button>
                <button @click="deleteTopic(contextMenu.topic!); closeContext()">删除主题</button>
            </div>
            </template>
        </div>
    </section>
</template>

<style lang="scss" scoped>
.messages {
    min-height: 0;
}
.panel-body {
    min-height: 0;
    position: relative;
}

.mismatch {
    flex: 1;
    min-height: 0;
    display: grid;
    place-items: center;
    padding: 40px 24px;
    text-align: center;
    color: var(--text-2);

    .emoji {
        font-size: 56px;
        margin-bottom: 14px;
        opacity: 0.8;
    }
    .title {
        font-size: 16px;
        font-weight: 600;
        color: var(--text-0);
        margin-bottom: 8px;
    }
    .desc {
        font-size: 12px;
        color: var(--text-2);
        line-height: 1.6;
        max-width: 440px;
    }
}
.mode-toggle {
    display: inline-flex;
    padding: 2px;
    background: var(--input-bg);
    border-radius: 8px;
    border: 1px solid var(--border);

    .tgl {
        background: transparent;
        border: none;
        color: var(--text-2);
        font-size: 12px;
        padding: 5px 10px;
        border-radius: 6px;
        cursor: pointer;
        font-family: inherit;
        transition: background 0.15s, color 0.15s;

        &:hover {
            color: var(--text-0);
        }
        &.active {
            background: rgba(124, 92, 255, 0.28);
            color: #fff;
        }
    }
}
.filter-row {
    display: flex;
    gap: 8px;
    align-items: stretch;
    flex: 0 0 auto;
}

.filter-input {
    flex: 1;
    padding: 8px 12px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-0);
    font-size: 13px;
    outline: none;
    &:focus {
        border-color: var(--accent);
    }
}

.follow-btn {
    padding: 0 12px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    color: var(--text-2);
    border-radius: 8px;
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
    white-space: nowrap;

    &:hover {
        background: var(--card-hover-bg);
        color: var(--text-0);
    }
    &.active {
        background: rgba(124, 92, 255, 0.25);
        border-color: rgba(124, 92, 255, 0.5);
        color: #fff;
    }
}

.paused-banner {
    position: absolute;
    left: 50%;
    top: 70px;
    transform: translateX(-50%);
    padding: 6px 14px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    background: rgba(245, 158, 11, 0.18);
    border: 1px solid rgba(245, 158, 11, 0.45);
    color: #fbbf24;
    box-shadow: 0 8px 20px -6px rgba(245, 158, 11, 0.35);
    z-index: 5;
    pointer-events: none;
    white-space: nowrap;
}

.jump-top {
    position: absolute;
    right: 18px;
    bottom: 16px;
    padding: 8px 14px;
    border-radius: 999px;
    border: none;
    background: linear-gradient(135deg, #7c5cff, #5b8def);
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 8px 20px -4px rgba(124, 92, 255, 0.5);
    transition: transform 0.15s, filter 0.15s;
    z-index: 5;

    &:hover {
        filter: brightness(1.1);
        transform: translateY(-1px);
    }
}

.split {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(240px, 0.42fr) 1fr;
    gap: 12px;
}

.topic-list,
.topic-detail {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--panel-body-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
}
.t-head {
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-2);
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;

    .t-head-name {
        flex: 1;
        min-width: 0;
        color: var(--accent-2);
        font-family: 'JetBrains Mono', Consolas, monospace;
        user-select: text;
        cursor: text;
        word-break: break-all;
        line-height: 1.4;
    }
}
.sort-select {
    background: var(--input-bg);
    border: 1px solid var(--border);
    color: var(--text-1);
    border-radius: 6px;
    padding: 2px 6px;
    font-size: 11px;
    font-family: inherit;
    outline: none;
    cursor: pointer;
    &:focus {
        border-color: var(--accent);
    }
}
.t-list {
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.t-item {
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: rgba(255, 255, 255, 0.02);
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;

    &:hover {
        background: rgba(255, 255, 255, 0.06);
        border-color: var(--border-strong);
    }
    &.active {
        background: rgba(124, 92, 255, 0.2);
        border-color: rgba(124, 92, 255, 0.55);
    }
    &.disabled {
        opacity: 0.5;
    }
    .t-name {
        font-size: var(--fs-msg-topic);
        font-family: 'JetBrains Mono', Consolas, monospace;
        color: var(--text-0);
        line-height: 1.45;
        word-break: break-all;
        user-select: text;
        cursor: text;
    }
    .t-meta {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: var(--text-3);
        margin-top: 4px;
        .count {
            color: var(--accent-2);
            font-weight: 600;
        }
        .ago {
            font-family: 'JetBrains Mono', Consolas, monospace;
        }
    }
}

.scroll-area {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    position: relative;

    &.bordered {
        background: var(--panel-body-bg);
        border: 1px solid var(--border);
        border-radius: 10px;
    }
}

.msg-list {
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

/* 让浏览器自动跳过离屏卡片的布局/渲染，近似虚拟化 */
.cv-auto {
    content-visibility: auto;
    contain-intrinsic-size: auto 80px;
}

.msg-card {
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--card-bg);
    user-select: text;
    cursor: text;

    &:hover {
        border-color: var(--border-strong);
        background: var(--card-hover-bg);
    }

    .msg-head {
        display: flex;
        gap: 10px;
        align-items: baseline;
        font-size: var(--fs-msg-meta);
        flex-wrap: wrap;
        .time {
            color: var(--text-3);
            font-family: 'JetBrains Mono', Consolas, monospace;
            flex: 0 0 auto;
        }
        .topic {
            color: var(--accent-2);
            font-family: 'JetBrains Mono', Consolas, monospace;
            font-weight: 600;
            word-break: break-all;
            line-height: 1.4;
            font-size: var(--fs-msg-topic);
            user-select: text;
            cursor: text;
        }
        .msg-hint {
            margin-left: auto;
            color: var(--text-3);
            font-size: 10px;
            opacity: 0;
            transition: opacity 0.15s;
            user-select: none;
        }
    }
    &:hover .msg-head .msg-hint {
        opacity: 0.7;
    }
    .msg-body {
        margin: 4px 0 0;
        font-family: 'JetBrains Mono', Consolas, monospace;
        font-size: var(--fs-msg);
        color: var(--text-1);
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-all;
        background: transparent;
        padding: 0;
    }
}

.ctx {
    position: fixed;
    background: var(--bg-1);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    padding: 4px;
    z-index: 1000;
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    min-width: 140px;

    button {
        background: transparent;
        color: var(--text-1);
        border: none;
        padding: 6px 10px;
        text-align: left;
        border-radius: 4px;
        font-size: 12px;
        cursor: pointer;
        &:hover {
            background: var(--card-hover-bg);
        }
    }
}
</style>
