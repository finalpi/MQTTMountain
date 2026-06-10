<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import JsonTreeView from '@/components/JsonTreeView.vue';
import { useFormatViewer } from '@/composables/useFormatViewer';
import { useMessageStore, type MsgRow } from '@/stores/messages';
import { useConnectionStore } from '@/stores/connection';
import { useToast } from '@/composables/useToast';
import { formatTime } from '@/utils/format';
import { escapeHtml } from '@/utils/filter';
import type { DecodedResult, PluginDecodedMeta, PluginReplyBlock } from '@shared/plugin';

const { state, close, applyDraft, publishDraft, repeatHistory } = useFormatViewer();
const msg = useMessageStore();
const conn = useConnectionStore();
const toast = useToast();

const decoded = ref<DecodedResult | null>(null);
const decoding = ref(false);
const decodedCollapsed = ref(false);
let decodeTimer: ReturnType<typeof setTimeout> | null = null;
let decodeSeq = 0;

watch(
    () => [state.visible, state.editable ? state.draftRaw : state.raw, state.editable ? state.draftTopic : state.topic] as const,
    ([vis, raw, topic]) => {
        if (decodeTimer) {
            clearTimeout(decodeTimer);
            decodeTimer = null;
        }
        const seq = ++decodeSeq;
        if (!vis) {
            decoded.value = null;
            decodedCollapsed.value = false;
            decoding.value = false;
            return;
        }
        if (!raw) {
            decoded.value = null;
            decodedCollapsed.value = false;
            return;
        }
        decoding.value = true;
        decodeTimer = setTimeout(async () => {
            try {
                const r = await window.api.pluginDecode({ topic, payload: raw });
                if (seq !== decodeSeq) return;
                decoded.value = r.success && r.data ? r.data : null;
                decodedCollapsed.value = false;
            } finally {
                if (seq === decodeSeq) decoding.value = false;
            }
        }, state.editable ? 220 : 0);
    }
);

const search = ref('');
const caseSensitive = ref(false);
const currentIndex = ref(0);
const matchCount = ref(0);
const jsonCollapsedPaths = ref<Set<string>>(new Set());

const bodyEl = ref<HTMLElement | null>(null);

const displayRaw = computed(() => state.editable ? state.draftRaw : state.raw);
const displayTopic = computed(() => state.editable ? state.draftTopic : state.topic);

interface DecodedFieldValue {
    path: string;
    key: string;
    label: string;
    value?: string;
}

/** 尝试 JSON 解析，失败则按原样显示 */
const formatted = computed<{ text: string; isJson: boolean; value: unknown }>(() => {
    const s = displayRaw.value;
    if (!s) return { text: '', isJson: false, value: null };
    try {
        const v = JSON.parse(s);
        return { text: JSON.stringify(v, null, 2), isJson: true, value: v };
    } catch {
        return { text: s, isJson: false, value: null };
    }
});

function collectJsonBranchPaths(value: unknown, path = '$'): string[] {
    if (Array.isArray(value)) {
        return [path, ...value.flatMap((child, index) => collectJsonBranchPaths(child, `${path}[${index}]`))];
    }
    if (value && typeof value === 'object') {
        return [
            path,
            ...Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
                collectJsonBranchPaths(child, `${path}.${encodeURIComponent(key)}`)
            )
        ];
    }
    return [];
}

function refreshSearchHighlights(): void {
    nextTick().then(applySearchHighlights);
}

function toggleJsonPath(path: string): void {
    clearHighlights();
    const next = new Set(jsonCollapsedPaths.value);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    jsonCollapsedPaths.value = next;
    refreshSearchHighlights();
}

function collapseJson(): void {
    clearHighlights();
    jsonCollapsedPaths.value = new Set(collectJsonBranchPaths(formatted.value.value).filter((path) => path !== '$'));
    refreshSearchHighlights();
}

function expandJson(): void {
    clearHighlights();
    jsonCollapsedPaths.value = new Set();
    refreshSearchHighlights();
}

const decodedFieldValues = computed<DecodedFieldValue[]>(() => {
    const detail = decoded.value as (DecodedResult & {
        fieldValues?: DecodedFieldValue[];
        fieldLabels?: DecodedFieldValue[];
    }) | null;
    const values = detail?.fieldValues || detail?.fieldLabels;
    return Array.isArray(values) ? values.slice(0, 160) : [];
});

const decodedDisplayItems = computed(() => {
    const out: { label: string; value: string }[] = [];
    const seen = new Set<string>();
    const push = (label?: string, value?: string): void => {
        if (!label || !value) return;
        const key = `${label}\u0000${value}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ label, value });
    };
    decoded.value?.highlights?.forEach((item) => push(item.label, item.value));
    decodedFieldValues.value.forEach((item) => push(item.label, item.value || ''));
    return out;
});

const replyBlocks = computed<PluginReplyBlock[]>(() => {
    const blocks = decoded.value?.replyBlocks;
    return Array.isArray(blocks) ? blocks : [];
});
const previewReplyBlocks = computed<PluginReplyBlock[]>(() => (state.editable ? [] : replyBlocks.value));

interface ReplyMatch {
    row: MsgRow;
}

function normalizeMethod(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isMatchingReply(meta: PluginDecodedMeta | undefined, target: PluginDecodedMeta): boolean {
    if (!meta?.isReply) return false;
    if (target.tid && meta.tid !== target.tid) return false;
    if (target.bid && meta.bid !== target.bid) return false;
    const targetMethod = normalizeMethod(target.method);
    const metaMethod = normalizeMethod(meta.method);
    if (targetMethod && metaMethod && metaMethod !== targetMethod) return false;
    return Boolean(target.tid || target.bid || (targetMethod && metaMethod));
}

const actualReply = computed<ReplyMatch | null>(() => {
    if (!state.editable || !state.publishTracking) return null;
    const targetMeta = decoded.value?.meta;
    if (!targetMeta) return null;
    const connectionId = state.publishTracking.connectionId || state.connectionId || conn.selectedId;
    if (!connectionId) return null;
    const bucket = msg.bucketFor(connectionId);
    void bucket.timelineVersion;
    const rows = bucket.timeline.snapshot();
    for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (row.time < state.publishTracking.sinceTime) continue;
        if (!isMatchingReply(row.decoded?.meta, targetMeta)) continue;
        return { row };
    }
    return null;
});

const previewReplyRaw = computed(() => actualReply.value?.row.payload || '');

/** 在已渲染 HTML 上套搜索高亮（遍历文本节点） */
function applySearchHighlights(): void {
    const el = bodyEl.value;
    if (!el) return;
    clearHighlights();
    const q = search.value;
    if (!q) {
        matchCount.value = 0;
        currentIndex.value = 0;
        return;
    }
    const flags = caseSensitive.value ? 'g' : 'gi';
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, flags);

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);

    let count = 0;
    for (const t of nodes) {
        const text = t.nodeValue || '';
        if (!re.test(text)) { re.lastIndex = 0; continue; }
        re.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let last = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) != null) {
            if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            const mark = document.createElement('mark');
            mark.className = 'search-hit';
            mark.dataset.idx = String(count);
            mark.textContent = m[0];
            frag.appendChild(mark);
            last = m.index + m[0].length;
            count++;
            if (m[0].length === 0) re.lastIndex++;
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        t.parentNode?.replaceChild(frag, t);
    }

    matchCount.value = count;
    currentIndex.value = count > 0 ? 1 : 0;
    focusCurrent();
}

function clearHighlights(): void {
    const el = bodyEl.value;
    if (!el) return;
    const marks = el.querySelectorAll('mark.search-hit');
    marks.forEach((m) => {
        const parent = m.parentNode;
        if (!parent) return;
        parent.replaceChild(document.createTextNode(m.textContent || ''), m);
        parent.normalize();
    });
}

function focusCurrent(): void {
    const el = bodyEl.value;
    if (!el) return;
    const target = el.querySelector<HTMLElement>(`mark.search-hit[data-idx="${currentIndex.value - 1}"]`);
    el.querySelectorAll('mark.search-hit.current').forEach((n) => n.classList.remove('current'));
    if (target) {
        target.classList.add('current');
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
}

function nextMatch(): void {
    if (matchCount.value === 0) return;
    currentIndex.value = currentIndex.value >= matchCount.value ? 1 : currentIndex.value + 1;
    focusCurrent();
}
function prevMatch(): void {
    if (matchCount.value === 0) return;
    currentIndex.value = currentIndex.value <= 1 ? matchCount.value : currentIndex.value - 1;
    focusCurrent();
}

function placeTimePop(e: Event): void {
    const target = e.target instanceof Element ? e.target.closest<HTMLElement>('.json-time, .k-time') : null;
    if (!target) return;
    const pop = target.querySelector<HTMLElement>('.time-pop');
    if (!pop) return;

    const originalDisplay = pop.style.display;
    const originalVisibility = pop.style.visibility;
    pop.style.display = 'block';
    pop.style.visibility = 'hidden';
    const popHeight = pop.offsetHeight || 72;
    const popWidth = pop.offsetWidth || 260;
    pop.style.display = originalDisplay;
    pop.style.visibility = originalVisibility;

    const triggerRect = target.getBoundingClientRect();
    const containerRect = bodyEl.value?.getBoundingClientRect();
    const viewTop = Math.max(0, containerRect?.top ?? 0);
    const viewBottom = Math.min(window.innerHeight, containerRect?.bottom ?? window.innerHeight);
    const viewLeft = Math.max(0, containerRect?.left ?? 0);
    const viewRight = Math.min(window.innerWidth, containerRect?.right ?? window.innerWidth);
    const gap = 8;

    const spaceBelow = viewBottom - triggerRect.bottom - gap;
    const spaceAbove = triggerRect.top - viewTop - gap;
    const placeAbove = spaceBelow < popHeight && spaceAbove > spaceBelow;
    const centerX = triggerRect.left + triggerRect.width / 2;
    const alignLeft = centerX - popWidth / 2 < viewLeft;
    const alignRight = !alignLeft && centerX + popWidth / 2 > viewRight;

    target.classList.toggle('time-pop-above', placeAbove);
    target.classList.toggle('time-pop-below', !placeAbove);
    target.classList.toggle('time-pop-align-left', alignLeft);
    target.classList.toggle('time-pop-align-right', alignRight);
}

async function copyAll(): Promise<void> {
    try {
        await navigator.clipboard.writeText(formatted.value.text);
        toast.success('已复制全部内容');
    } catch {
        toast.error('复制失败');
    }
}

function formatDraft(): void {
    if (!state.editable || !state.draftRaw.trim()) return;
    try {
        state.draftRaw = JSON.stringify(JSON.parse(state.draftRaw), null, 2);
        refreshSearchHighlights();
    } catch {
        toast.error('不是合法 JSON，无法格式化');
    }
}

function applyAndClose(): void {
    applyDraft();
    toast.success('已应用到发送框');
    close();
}

function onKeydown(e: KeyboardEvent): void {
    if (!state.visible) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if ((e.key === 'f' || e.key === 'F') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>('.fv-search-input');
        input?.focus();
        input?.select();
        return;
    }
    if (e.key === 'F3' || (e.key === 'Enter' && document.activeElement?.classList.contains('fv-search-input'))) {
        e.preventDefault();
        if (e.shiftKey) prevMatch(); else nextMatch();
    }
}

window.addEventListener('keydown', onKeydown);
onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown);
    if (decodeTimer) clearTimeout(decodeTimer);
});

watch(
    () => [state.visible, displayRaw.value, search.value, caseSensitive.value] as const,
    async () => {
        if (!state.visible) return;
        await nextTick();
        applySearchHighlights();
    }
);

watch(
    () => state.visible,
    (v) => {
        if (v) {
            search.value = '';
            matchCount.value = 0;
            currentIndex.value = 0;
            jsonCollapsedPaths.value = new Set();
        }
    }
);

const title = computed(() => displayTopic.value || '消息内容');
</script>

<template>
    <Teleport to="body">
        <Transition name="fv">
            <div v-if="state.visible" class="fv-overlay" @click.self="close">
                <div class="fv-modal">
                    <header class="fv-head">
                        <div class="fv-title">
                            <div class="fv-topic" :title="title">{{ title }}</div>
                            <div class="fv-meta">
                                <span v-if="state.time">{{ formatTime(state.time) }}</span>
                                <span v-if="state.editable" class="tag edit">可编辑</span>
                                <span v-if="formatted.isJson" class="tag">JSON</span>
                                <span v-else class="tag raw">RAW</span>
                                <span class="tag dim">{{ formatted.text.length }} 字符</span>
                            </div>
                        </div>

                        <div class="fv-search">
                            <input
                                class="fv-search-input"
                                v-model="search"
                                placeholder="搜索内容（Ctrl+F / Enter）"
                                @keydown.enter.prevent="nextMatch"
                                @keydown.shift.enter.prevent="prevMatch"
                            />
                            <button class="btn btn-mini" :class="{ active: caseSensitive }" title="区分大小写" @click="caseSensitive = !caseSensitive">Aa</button>
                            <span class="counter">{{ matchCount > 0 ? `${currentIndex}/${matchCount}` : '无匹配' }}</span>
                            <button class="btn btn-mini" @click="prevMatch" title="上一个 (Shift+Enter)">↑</button>
                            <button class="btn btn-mini" @click="nextMatch" title="下一个 (Enter)">↓</button>
                        </div>

                        <div class="fv-actions">
                            <button v-if="state.editable" class="btn btn-mini" @click="formatDraft" title="格式化编辑内容">格式化</button>
                            <button v-if="formatted.isJson" class="btn btn-mini" @click="collapseJson" title="折叠 JSON 对象和数组">全部折叠</button>
                            <button v-if="formatted.isJson" class="btn btn-mini" @click="expandJson" title="展开 JSON 对象和数组">全部展开</button>
                            <button v-if="state.editable" class="btn btn-mini" @click="applyAndClose" title="应用到发送框">应用</button>
                            <button v-if="state.editable && state.publishable" class="btn btn-mini btn-primary" @click="publishDraft" title="发送当前编辑内容">发送</button>
                            <button class="btn btn-mini" @click="copyAll" title="复制全部">复制</button>
                            <button class="btn btn-mini btn-danger" @click="close" title="关闭 (Esc)">×</button>
                        </div>
                    </header>

                    <div v-if="decoded" class="fv-decoded" :class="{ collapsed: decodedCollapsed }">
                        <div class="decoded-head">
                            <div v-if="decoded.summary" class="summary">{{ decoded.summary }}</div>
                            <button class="btn btn-mini" @click="decodedCollapsed = !decodedCollapsed">
                                {{ decodedCollapsed ? '展开' : '收起' }}
                            </button>
                        </div>
                        <div v-if="!decodedCollapsed && decodedDisplayItems.length && !state.editable" class="highlights">
                            <div v-for="(h, i) in decodedDisplayItems" :key="i" class="hl-item">
                                <span class="k">{{ h.label }}</span>
                                <span class="v">{{ h.value }}</span>
                            </div>
                        </div>
                    </div>

                    <div v-if="state.editable" class="fv-edit-shell">
                        <div class="fv-edit-main">
                            <label class="fv-edit-topic">
                                <span>目标主题</span>
                                <input v-model="state.draftTopic" placeholder="test/topic" />
                            </label>
                            <label class="fv-edit-content">
                                <span>消息内容</span>
                                <textarea v-model="state.draftRaw" spellcheck="false"></textarea>
                            </label>
                            <div v-if="state.publishTracking" class="reply-live" :class="{ matched: !!actualReply }">
                                <span v-if="actualReply">
                                    已收到真实回执 · {{ actualReply.row.topic }} · {{ formatTime(actualReply.row.time) }}
                                </span>
                                <span v-else>发送成功，等待真实回执...</span>
                            </div>
                            <div
                                class="fv-body fv-preview"
                                ref="bodyEl"
                                :class="{ 'is-json': formatted.isJson && !previewReplyRaw }"
                                @mouseover="placeTimePop"
                                @focusin="placeTimePop"
                            >
                                <div v-if="previewReplyRaw" class="reply-raw-shell">
                                    <div class="reply-raw-head">真实回执原文</div>
                                    <pre class="fv-raw reply-raw" v-html="escapeHtml(previewReplyRaw)"></pre>
                                </div>
                                <JsonTreeView
                                    v-else-if="formatted.isJson"
                                    :value="formatted.value"
                                    :collapsed-paths="jsonCollapsedPaths"
                                    @toggle="toggleJsonPath"
                                />
                                <pre v-else class="fv-raw" v-html="escapeHtml(formatted.text)"></pre>
                            </div>
                        </div>
                        <aside class="fv-history">
                            <div class="history-title">发送历史</div>
                            <div v-if="state.history.length === 0" class="history-empty">暂无发送记录</div>
                            <button
                                v-for="(h, idx) in state.history"
                                :key="idx"
                                type="button"
                                class="history-item"
                                @click="repeatHistory(h)"
                            >
                                <span class="time">{{ formatTime(h.time) }}</span>
                                <span class="pill">QoS {{ h.qos }}</span>
                                <span class="topic">{{ h.topic }}</span>
                                <span class="payload">{{ h.payload }}</span>
                            </button>
                        </aside>
                    </div>
                    <div
                        v-else
                        class="fv-body"
                        ref="bodyEl"
                        :class="{ 'is-json': formatted.isJson, 'has-reply-blocks': previewReplyBlocks.length > 0 }"
                        @mouseover="placeTimePop"
                        @focusin="placeTimePop"
                    >
                        <div v-if="previewReplyBlocks.length" class="reply-block-list">
                            <section v-for="(block, idx) in previewReplyBlocks" :key="idx" class="reply-block" :class="block.status || 'info'">
                                <div class="reply-title">{{ block.title }}</div>
                                <div v-if="block.summary" class="reply-summary">{{ block.summary }}</div>
                                <div v-if="block.fields?.length" class="reply-fields">
                                    <div v-for="(field, fieldIdx) in block.fields" :key="fieldIdx" class="reply-field">
                                        <span class="label">{{ field.label }}</span>
                                        <span class="value">{{ field.value }}</span>
                                    </div>
                                </div>
                            </section>
                        </div>
                        <JsonTreeView
                            v-else-if="formatted.isJson"
                            :value="formatted.value"
                            :collapsed-paths="jsonCollapsedPaths"
                            @toggle="toggleJsonPath"
                        />
                        <pre v-else class="fv-raw" v-html="escapeHtml(formatted.text)"></pre>
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style lang="scss" scoped>
.fv-overlay {
    position: fixed;
    inset: 0;
    background: rgba(4, 8, 20, 0.55);
    backdrop-filter: blur(6px);
    z-index: 2000;
    display: grid;
    place-items: center;
    padding: 3vh 3vw;
}

.fv-modal {
    width: 100%;
    max-width: 1200px;
    height: 100%;
    max-height: 94vh;
    background: var(--bg-1);
    border: 1px solid var(--border-strong);
    border-radius: 14px;
    box-shadow: 0 30px 80px -20px rgba(0, 0, 0, 0.9);
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.fv-head {
    display: grid;
    grid-template-columns: minmax(200px, 1fr) minmax(320px, 2fr) auto;
    gap: 14px;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--head-bg);
}

.fv-title {
    min-width: 0;
    .fv-topic {
        font-family: 'JetBrains Mono', Consolas, monospace;
        font-size: 13px;
        color: var(--accent-2);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-weight: 600;
    }
    .fv-meta {
        margin-top: 4px;
        display: flex;
        gap: 6px;
        align-items: center;
        flex-wrap: wrap;
        color: var(--text-3);
        font-size: 11px;
        font-family: 'JetBrains Mono', Consolas, monospace;

        .tag {
            padding: 1px 7px;
            border-radius: 4px;
            background: rgba(124, 92, 255, 0.25);
            color: #cfc5ff;
            font-size: 10px;
            letter-spacing: 0.5px;
            font-weight: 600;
            &.raw {
                background: rgba(148, 163, 184, 0.2);
                color: var(--text-1);
            }
            &.dim {
                background: transparent;
                color: var(--text-3);
                font-weight: 400;
            }
            &.edit {
                background: rgba(16, 185, 129, 0.18);
                color: #86efac;
            }
        }
    }
}

.fv-search {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 4px 6px;

    &:focus-within {
        border-color: var(--accent);
    }

    .fv-search-input {
        flex: 1;
        border: none;
        background: transparent;
        color: var(--text-0);
        font-size: 12px;
        font-family: inherit;
        outline: none;
        padding: 4px 6px;
        min-width: 0;
    }
    .counter {
        font-size: 11px;
        color: var(--text-3);
        font-family: 'JetBrains Mono', Consolas, monospace;
        white-space: nowrap;
    }
    .btn.active {
        background: rgba(124, 92, 255, 0.35);
        border-color: rgba(124, 92, 255, 0.5);
        color: #fff;
    }
}

.fv-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
}

.fv-edit-shell {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(260px, 320px);
    background: var(--bg-0);
}

.fv-edit-main {
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-rows: auto minmax(240px, 1fr) auto minmax(180px, 0.75fr);
    border-right: 1px solid var(--border);
}

.reply-live {
    margin: 12px 16px 0;
    padding: 10px 12px;
    border: 1px dashed rgba(251, 191, 36, 0.45);
    border-radius: 10px;
    background: rgba(251, 191, 36, 0.08);
    color: #fde68a;
    font-size: 12px;
    line-height: 1.5;

    &.matched {
        border-color: rgba(16, 185, 129, 0.45);
        background: rgba(16, 185, 129, 0.1);
        color: #bbf7d0;
    }
}

.fv-edit-topic,
.fv-edit-content {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);

    > span {
        color: var(--text-2);
        font-size: 11px;
        font-weight: 700;
    }
}

.fv-edit-topic input,
.fv-edit-content textarea {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--input-bg);
    color: var(--text-0);
    outline: none;
    font-family: 'JetBrains Mono', Consolas, Menlo, monospace;
    font-size: var(--fs-msg);

    &:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(124, 92, 255, 0.16);
    }
}

.fv-edit-topic input {
    padding: 9px 10px;
}

.fv-edit-content {
    min-height: 0;

    textarea {
        flex: 1;
        min-height: 0;
        resize: none;
        padding: 12px;
        line-height: 1.55;
        white-space: pre;
    }
}

.fv-preview {
    border-top: 1px solid var(--border);
}

.reply-raw-shell {
    min-height: 0;
    display: flex;
    flex-direction: column;
}

.reply-raw-head {
    padding: 10px 12px 0;
    color: var(--text-2);
    font-size: 11px;
    font-weight: 700;
}

.reply-raw {
    margin: 10px 12px 12px;
    flex: 1;
}

.fv-history {
    min-width: 0;
    min-height: 0;
    overflow: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.history-title {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 0 0 4px;
    background: var(--bg-0);
    color: var(--text-2);
    font-size: 12px;
    font-weight: 700;
}

.history-empty {
    color: var(--text-3);
    font-size: 12px;
    padding: 12px;
    text-align: center;
}

.history-item {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 8px;
    width: 100%;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--card-bg);
    color: var(--text-1);
    text-align: left;
    cursor: pointer;

    &:hover {
        background: var(--card-hover-bg);
        border-color: var(--border-strong);
    }

    .time {
        color: var(--text-3);
        font-family: 'JetBrains Mono', Consolas, monospace;
        font-size: 10px;
    }

    .pill {
        padding: 1px 7px;
        border-radius: 999px;
        border: 1px solid var(--border);
        color: var(--text-2);
        font-size: 10px;
        font-weight: 700;
    }

    .topic,
    .payload {
        flex: 1 1 100%;
        overflow: hidden;
        display: -webkit-box;
        -webkit-box-orient: vertical;
        font-family: 'JetBrains Mono', Consolas, monospace;
        line-height: 1.45;
        word-break: break-all;
    }

    .topic {
        -webkit-line-clamp: 2;
        color: var(--accent-2);
        font-size: 11px;
    }

    .payload {
        -webkit-line-clamp: 4;
        color: var(--text-2);
        font-size: 11px;
        white-space: pre-wrap;
    }
}

.fv-decoded {
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: rgba(124, 92, 255, 0.08);
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 180px;
    overflow-y: auto;

    &.collapsed {
        max-height: none;
        overflow: hidden;
    }

    .decoded-head {
        display: flex;
        gap: 10px;
        align-items: center;
        justify-content: space-between;
    }

    .summary {
        font-size: 13px;
        color: var(--text-0);
        font-weight: 600;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .highlights {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 14px;

        .hl-item {
            display: inline-flex;
            gap: 6px;
            align-items: baseline;
            font-size: 12px;
            font-family: 'JetBrains Mono', Consolas, monospace;
            .k {
                color: var(--text-3);
                &::after { content: ':'; }
            }
            .v {
                color: var(--accent-2);
                font-weight: 600;
            }
        }
    }

    .field-labels {
        margin-top: 2px;
        color: var(--text-2);
        font-size: 12px;

        summary {
            cursor: pointer;
            color: #bae6fd;
            font-weight: 700;
            user-select: none;
        }
    }

    .field-list {
        display: grid;
        grid-template-columns: 1fr;
        gap: 6px;
        margin-top: 8px;
        max-height: 240px;
        overflow: auto;
    }

    .field-item {
        display: grid;
        grid-template-columns: minmax(150px, 0.9fr) minmax(110px, auto) minmax(160px, 1fr);
        gap: 8px;
        align-items: baseline;
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 6px;
        padding: 4px 6px;
        background: rgba(15, 23, 42, 0.22);
        font-family: 'JetBrains Mono', Consolas, monospace;

        .path {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: var(--text-3);
        }

        .label {
            color: #bae6fd;
            font-weight: 700;
            white-space: nowrap;
        }

        .value {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: var(--text-0);
            font-weight: 600;
            text-align: right;
        }
    }
}

.fv-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    margin: 0;
    padding: 16px 18px;
    background: var(--bg-0);
    font-family: 'JetBrains Mono', Consolas, Menlo, monospace;
    font-size: var(--fs-msg);
    line-height: 1.55;
    color: var(--text-0);
    white-space: pre-wrap;
    word-break: break-all;
    user-select: text;
    cursor: text;

    &.is-json {
        color: var(--text-1);
    }

    &.has-reply-blocks {
        white-space: normal;
        word-break: normal;
    }
}

.reply-block-list {
    display: grid;
    gap: 12px;
}

.reply-block {
    border: 1px solid rgba(125, 211, 252, 0.28);
    border-radius: 12px;
    padding: 14px;
    background: rgba(15, 23, 42, 0.42);

    &.success {
        border-color: rgba(16, 185, 129, 0.38);
        background: rgba(16, 185, 129, 0.1);
    }

    &.warning {
        border-color: rgba(251, 191, 36, 0.42);
        background: rgba(251, 191, 36, 0.1);
    }

    &.error {
        border-color: rgba(239, 68, 68, 0.42);
        background: rgba(239, 68, 68, 0.1);
    }
}

.reply-title {
    color: var(--text-0);
    font-size: 14px;
    font-weight: 800;
}

.reply-summary {
    margin-top: 6px;
    color: var(--text-2);
    font-size: 12px;
    line-height: 1.5;
}

.reply-fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 8px;
    margin-top: 12px;
}

.reply-field {
    min-width: 0;
    padding: 8px 10px;
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 8px;
    background: rgba(2, 6, 23, 0.24);

    .label {
        display: block;
        color: var(--text-3);
        font-size: 11px;
        margin-bottom: 3px;
    }

    .value {
        display: block;
        color: var(--accent-2);
        font-family: 'JetBrains Mono', Consolas, monospace;
        font-size: 12px;
        font-weight: 700;
        overflow-wrap: anywhere;
    }
}

.fv-raw {
    margin: 0;
    font: inherit;
    color: inherit;
    white-space: inherit;
    word-break: inherit;
}

:deep(.json-line) {
    min-height: 1.55em;
}

:deep(.json-toggle),
:deep(.json-toggle-spacer) {
    display: inline-grid;
    place-items: center;
    width: 18px;
    height: 18px;
    margin-right: 2px;
    vertical-align: text-bottom;
}

:deep(.json-toggle) {
    border: none;
    background: transparent;
    color: var(--accent-2);
    cursor: pointer;
    font-size: 10px;
    padding: 0;
    border-radius: 4px;

    &:hover {
        background: rgba(124, 92, 255, 0.22);
    }
}

:deep(.json-key) {
    color: #8be9fd;
}

:deep(.json-string) {
    color: #a3e635;
}

:deep(.json-number) {
    color: #fbbf24;
}

:deep(.json-time) {
    position: relative;
    display: inline-block;
    border-bottom: 1px dotted rgba(251, 191, 36, 0.75);
    cursor: help;
}

:deep(.json-boolean) {
    color: #f472b6;
}

:deep(.json-null) {
    color: #94a3b8;
    font-style: italic;
}

:deep(.json-bracket),
:deep(.json-colon),
:deep(.json-comma) {
    color: var(--text-2);
}

:deep(.json-summary) {
    margin: 0 6px;
    color: var(--text-3);
    font-style: italic;
}

:deep(.json-time:hover .time-pop),
:deep(.json-time:focus .time-pop) {
    display: block;
}

:deep(.k-key) {
    color: #8be9fd;
}
:deep(.k-str) {
    color: #a3e635;
}
:deep(.k-num) {
    color: #fbbf24;
}
:deep(.k-time) {
    position: relative;
    display: inline-block;
    border-bottom: 1px dotted rgba(251, 191, 36, 0.75);
    cursor: help;
}
:deep(.k-time .time-pop),
:deep(.json-time .time-pop) {
    position: absolute;
    left: 50%;
    z-index: 3;
    display: none;
    min-width: 260px;
    max-width: 360px;
    transform: translateX(-50%);
    padding: 8px 10px;
    border: 1px solid rgba(125, 211, 252, 0.35);
    border-radius: 6px;
    background: rgba(8, 13, 30, 0.98);
    box-shadow: 0 14px 36px rgba(0, 0, 0, 0.38);
    color: #bae6fd;
    font-size: 11px;
    line-height: 1.45;
    pointer-events: none;
    white-space: normal;
    word-break: normal;
}
:deep(.k-time.time-pop-below .time-pop),
:deep(.json-time.time-pop-below .time-pop) {
    top: calc(100% + 8px);
}
:deep(.k-time.time-pop-above .time-pop),
:deep(.json-time.time-pop-above .time-pop) {
    bottom: calc(100% + 8px);
}
:deep(.k-time.time-pop-align-left .time-pop),
:deep(.json-time.time-pop-align-left .time-pop) {
    left: 0;
    transform: none;
}
:deep(.k-time.time-pop-align-right .time-pop),
:deep(.json-time.time-pop-align-right .time-pop) {
    right: 0;
    left: auto;
    transform: none;
}
:deep(.k-time .time-pop::after),
:deep(.json-time .time-pop::after) {
    content: '';
    position: absolute;
    left: 50%;
    width: 8px;
    height: 8px;
    background: rgba(8, 13, 30, 0.98);
}
:deep(.k-time.time-pop-below .time-pop::after),
:deep(.json-time.time-pop-below .time-pop::after) {
    top: 0;
    transform: translate(-50%, -5px) rotate(45deg);
    border-left: 1px solid rgba(125, 211, 252, 0.35);
    border-top: 1px solid rgba(125, 211, 252, 0.35);
}
:deep(.k-time.time-pop-above .time-pop::after),
:deep(.json-time.time-pop-above .time-pop::after) {
    top: 100%;
    transform: translate(-50%, -4px) rotate(45deg);
    border-right: 1px solid rgba(125, 211, 252, 0.35);
    border-bottom: 1px solid rgba(125, 211, 252, 0.35);
}
:deep(.k-time.time-pop-align-left .time-pop::after),
:deep(.json-time.time-pop-align-left .time-pop::after) {
    left: 18px;
}
:deep(.k-time.time-pop-align-right .time-pop::after),
:deep(.json-time.time-pop-align-right .time-pop::after) {
    right: 18px;
    left: auto;
}
:deep(.k-time .time-pop span),
:deep(.json-time .time-pop span) {
    display: block;
}
:deep(.k-time .time-pop span:first-child),
:deep(.json-time .time-pop span:first-child) {
    color: #fef3c7;
    font-weight: 700;
}
:deep(.k-time .time-pop span:last-child),
:deep(.json-time .time-pop span:last-child) {
    margin-top: 2px;
    color: #94a3b8;
}
:deep(.k-time:hover .time-pop),
:deep(.k-time:focus .time-pop) {
    display: block;
}
:deep(.k-bool) {
    color: #f472b6;
}
:deep(.k-null) {
    color: #94a3b8;
    font-style: italic;
}

:deep(mark.search-hit) {
    background: rgba(253, 224, 71, 0.35);
    color: #fde68a;
    border-radius: 2px;
    padding: 0 1px;

    &.current {
        background: #f59e0b;
        color: #111827;
        box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.4);
    }
}

.fv-enter-from,
.fv-leave-to {
    opacity: 0;
    .fv-modal {
        transform: scale(0.98);
    }
}
.fv-enter-active,
.fv-leave-active {
    transition: opacity 0.18s ease;
    .fv-modal {
        transition: transform 0.18s ease;
    }
}
</style>
