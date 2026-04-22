<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useFormatViewer } from '@/composables/useFormatViewer';
import { useToast } from '@/composables/useToast';
import { formatTime } from '@/utils/format';
import { escapeHtml } from '@/utils/filter';

const { state, close } = useFormatViewer();
const toast = useToast();

const search = ref('');
const caseSensitive = ref(false);
const currentIndex = ref(0);
const matchCount = ref(0);

const bodyEl = ref<HTMLElement | null>(null);

/** 尝试 JSON 解析，失败则按原样显示 */
const formatted = computed<{ text: string; isJson: boolean }>(() => {
    const s = state.raw;
    if (!s) return { text: '', isJson: false };
    try {
        const v = JSON.parse(s);
        return { text: JSON.stringify(v, null, 2), isJson: true };
    } catch {
        return { text: s, isJson: false };
    }
});

/** 简易 JSON 语法高亮（string/number/bool/null/key） */
function colorizeJson(src: string): string {
    const esc = escapeHtml(src);
    return esc.replace(
        /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g,
        (match) => {
            if (/^"/.test(match)) {
                if (/:$/.test(match)) return `<span class="k-key">${match}</span>`;
                return `<span class="k-str">${match}</span>`;
            }
            if (/true|false/.test(match)) return `<span class="k-bool">${match}</span>`;
            if (/null/.test(match)) return `<span class="k-null">${match}</span>`;
            return `<span class="k-num">${match}</span>`;
        }
    );
}

/** 在已渲染 HTML 上套搜索高亮（简单替换：遍历文本节点） */
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

async function copyAll(): Promise<void> {
    try {
        await navigator.clipboard.writeText(formatted.value.text);
        toast.success('已复制全部内容');
    } catch {
        toast.error('复制失败');
    }
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
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

// 内容或搜索词变化时重新高亮
watch(
    () => [state.visible, state.raw, search.value, caseSensitive.value] as const,
    async () => {
        if (!state.visible) return;
        await nextTick();
        applySearchHighlights();
    }
);

// 打开时重置搜索
watch(
    () => state.visible,
    (v) => {
        if (v) {
            search.value = '';
            matchCount.value = 0;
            currentIndex.value = 0;
        }
    }
);

const title = computed(() => state.topic || '消息内容');
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
                                <span v-if="formatted.isJson" class="tag">JSON</span>
                                <span v-else class="tag raw">RAW</span>
                                <span class="tag dim">{{ formatted.text.length }} 字符</span>
                            </div>
                        </div>

                        <div class="fv-search">
                            <input
                                class="fv-search-input"
                                v-model="search"
                                placeholder="🔍 搜索内容（Ctrl+F / Enter）"
                                @keydown.enter.prevent="nextMatch"
                                @keydown.shift.enter.prevent="prevMatch"
                            />
                            <button class="btn btn-mini" :class="{ active: caseSensitive }" title="区分大小写" @click="caseSensitive = !caseSensitive">Aa</button>
                            <span class="counter">{{ matchCount > 0 ? `${currentIndex}/${matchCount}` : '无匹配' }}</span>
                            <button class="btn btn-mini" @click="prevMatch" title="上一个 (Shift+Enter)">↑</button>
                            <button class="btn btn-mini" @click="nextMatch" title="下一个 (Enter)">↓</button>
                        </div>

                        <div class="fv-actions">
                            <button class="btn btn-mini" @click="copyAll" title="复制全部">📋 复制</button>
                            <button class="btn btn-mini btn-danger" @click="close" title="关闭 (Esc)">✕</button>
                        </div>
                    </header>

                    <pre
                        class="fv-body"
                        ref="bodyEl"
                        :class="{ 'is-json': formatted.isJson }"
                        v-html="formatted.isJson ? colorizeJson(formatted.text) : escapeHtml(formatted.text)"
                    ></pre>
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
