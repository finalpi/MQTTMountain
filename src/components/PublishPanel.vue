<script setup lang="ts">
import { ref, computed, nextTick } from 'vue';
import { useConnectionStore } from '@/stores/connection';
import { useMessageStore } from '@/stores/messages';
import { useToast } from '@/composables/useToast';
import { useUiPrefs } from '@/composables/useUiPrefs';
import { usePluginStore } from '@/stores/plugins';
import { useParamMemory } from '@/composables/useParamMemory';
import { shortTime } from '@/utils/format';
import type { SenderDefinition } from '@shared/plugin';

const conn = useConnectionStore();
const msg = useMessageStore();
const toast = useToast();
const { prefs, toggleRight } = useUiPrefs();
const plugins = usePluginStore();
const paramMem = useParamMemory();
const isOpen = computed(() => prefs.activeRight === 'pub');

function datalistId(paramKey: string): string {
    return `mm-paramlist-${paramKey}`;
}

const topic = ref('test/message');
const qos = ref<0 | 1 | 2>(0);
const retain = ref(false);
const payload = ref('{"msg": "hello"}');
const payloadEl = ref<HTMLTextAreaElement | null>(null);

const canOp = computed(() => conn.selectedState === 'connected');

/** JSON 语法校验，返回合法性 + 行列定位 */
interface JsonStatus {
    level: 'empty' | 'ok' | 'err';
    kind?: string;
    line?: number;
    col?: number;
    pos?: number;
    message?: string;
}

const jsonStatus = computed<JsonStatus>(() => {
    const s = payload.value;
    if (!s || !s.trim()) return { level: 'empty' };
    try {
        const v = JSON.parse(s);
        let kind: string;
        if (v === null) kind = 'null';
        else if (Array.isArray(v)) kind = `array (${v.length} 项)`;
        else if (typeof v === 'object') kind = `object (${Object.keys(v).length} 个字段)`;
        else kind = typeof v;
        return { level: 'ok', kind };
    } catch (err) {
        const raw = (err as Error).message || '';
        // V8: "Unexpected token } in JSON at position 15"
        // Firefox/SpiderMonkey: "JSON.parse: ... at line 2 column 5"
        let line = 0;
        let col = 0;
        let pos = -1;
        const mPos = raw.match(/position (\d+)/);
        const mLine = raw.match(/line (\d+) column (\d+)/i);
        if (mLine) {
            line = Number(mLine[1]);
            col = Number(mLine[2]);
        } else if (mPos) {
            pos = Number(mPos[1]);
            const before = s.slice(0, pos);
            const parts = before.split('\n');
            line = parts.length;
            col = parts[parts.length - 1].length + 1;
        }
        // 只保留错误类型简短描述
        const clean = raw
            .replace(/^JSON\.parse:\s*/i, '')
            .replace(/\s*in JSON at position \d+/i, '')
            .replace(/\s*at line \d+ column \d+.*$/i, '')
            .replace(/\s*\(line \d+ column \d+.*\)$/i, '')
            .trim();
        return { level: 'err', line, col, pos, message: clean };
    }
});

function focusError(): void {
    const el = payloadEl.value;
    const st = jsonStatus.value;
    if (!el || st.level !== 'err') return;
    el.focus();
    let pos = st.pos ?? -1;
    if (pos < 0 && st.line && st.col) {
        const lines = payload.value.split('\n');
        pos = 0;
        for (let i = 0; i < (st.line! - 1) && i < lines.length; i++) pos += lines[i].length + 1;
        pos += (st.col! - 1);
    }
    if (pos >= 0) {
        el.setSelectionRange(pos, Math.min(pos + 1, payload.value.length));
    }
}

function tryFormat(): void {
    const s = payload.value;
    if (!s.trim()) return;
    try {
        payload.value = JSON.stringify(JSON.parse(s), null, 2);
        nextTick(() => payloadEl.value?.focus());
    } catch {
        toast.error('不是合法 JSON，无法格式化');
        focusError();
    }
}

async function doPublish(): Promise<void> {
    const c = conn.selected;
    if (!c) return;
    if (!canOp.value) { toast.error('请先连接'); return; }
    if (!topic.value.trim()) { toast.error('主题不能为空'); return; }
    const r = await window.api.mqttPublish({
        connectionId: c.id,
        topic: topic.value.trim(),
        payload: payload.value,
        qos: qos.value,
        retain: retain.value
    });
    if (r.success) {
        const item = { topic: topic.value.trim(), payload: payload.value, qos: qos.value, retain: retain.value, time: Date.now() };
        msg.pushPublishHistory(c.id, item);
        await window.api.publishHistoryAppend({ connectionId: c.id, ...item });
        // 发送成功后把当前 sender 的参数值记入历史，下次可下拉选择
        if (activeSender.value?.params) {
            for (const pr of activeSender.value.params) {
                paramMem.remember(pr.key, paramValues.value[pr.key]);
            }
        }
        toast.success('已发送');
    } else {
        toast.error('发送失败：' + (r.message || ''));
    }
}

function repeat(item: { topic: string; payload: string; qos: number; retain: boolean }): void {
    topic.value = item.topic;
    payload.value = item.payload;
    qos.value = item.qos as 0 | 1 | 2;
    retain.value = item.retain;
}

/** 插件提供的发送模板，按插件分组用于下拉展示 */
const senderGroups = computed(() => {
    const map = new Map<string, (SenderDefinition & { pluginId: string; pluginName: string })[]>();
    for (const s of plugins.allSenders) {
        const key = s.pluginName;
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(s);
    }
    return [...map.entries()].map(([name, items]) => ({ name, items }));
});

const paramValues = ref<Record<string, string>>({});
const paramSuggestionCache = ref<Record<string, string[]>>({});
const activeSender = ref<(SenderDefinition & { pluginId: string; pluginName: string }) | null>(null);

function cloudSnFromTopic(topicText: string | undefined): string | undefined {
    const parts = String(topicText || '').split('/');
    if ((parts[0] === 'thing' || parts[0] === 'sys') && parts[1] === 'product' && parts[2]) {
        return parts[2];
    }
    return undefined;
}

function suggestionListFor(paramKey: string): string[] {
    const values = new Set<string>();
    const addAll = (items: Array<string | undefined>): void => {
        for (const item of items) {
            if (typeof item === 'string' && item.trim()) values.add(item.trim());
        }
    };

    if (paramKey === 'airportSn') {
        addAll(paramMem.suggestionsFor('airportSn'));
        addAll(paramMem.suggestionsFor('gateway'));
    } else {
        addAll(paramMem.suggestionsFor(paramKey));
    }

    const bucket = msg.bucketFor(conn.selectedId);
    void bucket.timelineVersion;
    void bucket.publishHistoryVersion;

    if (paramKey === 'airportSn' || paramKey === 'droneSn') {
        for (const row of bucket.timeline.snapshot()) {
            const meta = row.decoded?.meta;
            if (!meta || meta.family !== 'dji-shangyun') continue;
            if (paramKey === 'airportSn' && typeof meta.airportSn === 'string') values.add(meta.airportSn);
            if (paramKey === 'droneSn' && typeof meta.droneSn === 'string') values.add(meta.droneSn);
        }
    }

    if (paramKey === 'airportSn') {
        for (const item of bucket.publishHistory.snapshot()) {
            const sn = cloudSnFromTopic(item.topic);
            if (sn) values.add(sn);
        }
    }

    return [...values];
}

function applyTemplate(tpl: string, vals: Record<string, string>): string {
    return tpl.replace(/\{(\w+)\}/g, (_, k) => vals[k] ?? `{${k}}`);
}

function pickSender(id: string): void {
    const s = plugins.allSenders.find((x) => x.id === id);
    if (!s) { activeSender.value = null; return; }
    activeSender.value = s;
    paramValues.value = {};
    paramSuggestionCache.value = {};
    for (const pr of s.params ?? []) {
        // 优先用记忆里最近一次的值，其次用插件声明的 default
        const suggestions = suggestionListFor(pr.key);
        paramSuggestionCache.value[pr.key] = suggestions;
        const memo = suggestions[0];
        const initial = memo != null && memo !== '' ? memo : String(pr.default ?? '');
        paramValues.value[pr.key] = initial;
    }
    topic.value = applyTemplate(s.topic, paramValues.value);
    payload.value = applyTemplate(s.payloadTemplate, paramValues.value);
    if (s.qos != null) qos.value = s.qos;
    if (s.retain != null) retain.value = s.retain;
}

function onParamInput(): void {
    const s = activeSender.value;
    if (!s) return;
    topic.value = applyTemplate(s.topic, paramValues.value);
    payload.value = applyTemplate(s.payloadTemplate, paramValues.value);
}

const historyList = computed(() => {
    const b = msg.bucketFor(conn.selectedId);
    void b.publishHistoryVersion;
    return b.publishHistory.snapshot().reverse();
});
</script>

<template>
    <section class="panel" :class="{ open: isOpen }">
        <div class="panel-head clickable" @click="toggleRight('pub')">
            <h2>📤 发布消息</h2>
            <span class="spacer"></span>
            <span class="chev">{{ isOpen ? '▾' : '▸' }}</span>
        </div>
        <div v-if="isOpen" class="panel-body">
            <div v-if="senderGroups.length" class="field">
                <label>🧩 插件模板</label>
                <select :value="activeSender?.id ?? ''" @change="pickSender(($event.target as HTMLSelectElement).value)">
                    <option value="">— 自定义发送 —</option>
                    <optgroup v-for="g in senderGroups" :key="g.name" :label="g.name">
                        <option v-for="s in g.items" :key="s.id" :value="s.id">{{ s.name }}</option>
                    </optgroup>
                </select>
            </div>
            <div v-if="activeSender && (activeSender.params?.length ?? 0) > 0" class="sender-params">
                <div v-for="p in activeSender.params" :key="p.key" class="field">
                    <label>
                        <span>{{ p.label }}{{ p.required ? ' *' : '' }}</span>
                        <span
                            v-if="p.type !== 'select' && (paramSuggestionCache[p.key] ?? []).length"
                            class="mem-tag"
                            :title="(paramSuggestionCache[p.key] ?? []).join('\n')"
                        >🕘 {{ (paramSuggestionCache[p.key] ?? []).length }} 条历史</span>
                    </label>
                    <select v-if="p.type === 'select'" v-model="paramValues[p.key]" @change="onParamInput">
                        <option v-for="opt in (p.options ?? [])" :key="opt" :value="opt">{{ opt }}</option>
                    </select>
                    <input
                        v-else
                        :type="p.type === 'number' ? 'number' : 'text'"
                        v-model="paramValues[p.key]"
                        :placeholder="p.placeholder"
                        :list="p.type === 'number' ? undefined : datalistId(p.key)"
                        @input="onParamInput"
                        @focus="paramSuggestionCache[p.key] = suggestionListFor(p.key)"
                    />
                    <datalist v-if="p.type !== 'number' && p.type !== 'select'" :id="datalistId(p.key)">
                        <option v-for="v in (paramSuggestionCache[p.key] ?? [])" :key="v" :value="v" />
                    </datalist>
                </div>
            </div>

            <div class="field">
                <label>目标主题</label>
                <input v-model="topic" placeholder="test/topic" />
            </div>
            <div class="field-row">
                <div class="field">
                    <label>QoS</label>
                    <select v-model.number="qos">
                        <option :value="0">0</option>
                        <option :value="1">1</option>
                        <option :value="2">2</option>
                    </select>
                </div>
                <div class="field">
                    <label>Retain</label>
                    <select :value="retain ? 'true' : 'false'" @change="retain = ($event.target as HTMLSelectElement).value === 'true'">
                        <option value="false">false</option>
                        <option value="true">true</option>
                    </select>
                </div>
            </div>
            <div class="field">
                <label class="payload-label">
                    <span>消息内容</span>
                    <button class="btn btn-mini btn-ghost" @click="tryFormat">🪄 格式化</button>
                </label>
                <textarea
                    ref="payloadEl"
                    v-model="payload"
                    rows="5"
                    spellcheck="false"
                    :class="['payload-input', `is-${jsonStatus.level}`]"
                ></textarea>
                <div class="payload-status" :class="`is-${jsonStatus.level}`">
                    <template v-if="jsonStatus.level === 'ok'">
                        <span class="icon">✓</span>
                        <span>合法 JSON · {{ jsonStatus.kind }}</span>
                    </template>
                    <template v-else-if="jsonStatus.level === 'err'">
                        <span class="icon">⚠</span>
                        <span class="loc" @click="focusError" title="点击跳转到错误位置">
                            第 {{ jsonStatus.line }} 行 第 {{ jsonStatus.col }} 列
                        </span>
                        <span class="msg">{{ jsonStatus.message }}</span>
                    </template>
                    <template v-else>
                        <span class="icon dim">·</span>
                        <span>内容为空</span>
                    </template>
                </div>
            </div>
            <button class="btn btn-primary" :disabled="!canOp" @click="doPublish">发布</button>

            <div class="history">
                <label>发送历史</label>
                <div v-if="historyList.length === 0" class="empty">暂无发送记录</div>
                <div v-for="(h, idx) in historyList" :key="idx" class="item" @click="repeat(h)" title="点击重放">
                    <span class="time">{{ shortTime(h.time) }}</span>
                    <span class="pill">QoS {{ h.qos }}</span>
                    <span class="t">{{ h.topic }}</span>
                    <span class="p">{{ h.payload }}</span>
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

.sender-params {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;

    .field label {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 8px;
    }
    .mem-tag {
        font-size: 10px;
        color: var(--accent);
        background: rgba(124, 92, 255, 0.12);
        padding: 1px 6px;
        border-radius: 999px;
        white-space: nowrap;
        cursor: help;
    }
}

.payload-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.payload-input {
    transition: border-color 0.15s, box-shadow 0.15s;

    &.is-err {
        border-color: rgba(239, 68, 68, 0.55) !important;
        &:focus {
            box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.2) !important;
        }
    }
    &.is-ok {
        border-color: rgba(16, 185, 129, 0.35) !important;
    }
}

.payload-status {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 11px;
    line-height: 1.4;
    font-family: inherit;
    min-height: 26px;

    .icon {
        font-weight: 700;
        font-size: 13px;
        line-height: 1;
    }

    &.is-ok {
        background: rgba(16, 185, 129, 0.12);
        color: #10b981;
        border: 1px solid rgba(16, 185, 129, 0.3);
    }
    &.is-err {
        background: rgba(239, 68, 68, 0.1);
        color: #f87171;
        border: 1px solid rgba(239, 68, 68, 0.3);
        flex-wrap: wrap;

        .loc {
            font-family: 'JetBrains Mono', Consolas, monospace;
            font-weight: 600;
            cursor: pointer;
            text-decoration: underline;
            text-decoration-style: dotted;
            text-underline-offset: 3px;
            &:hover {
                color: #fca5a5;
            }
        }
        .msg {
            color: var(--text-2);
            font-family: 'JetBrains Mono', Consolas, monospace;
        }
    }
    &.is-empty {
        color: var(--text-3);
        .icon.dim { color: var(--text-3); }
    }
}

.history {
    margin-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;

    > label {
        font-size: 11px;
        color: var(--text-2);
        position: sticky;
        top: 0;
        background: var(--surface);
        padding: 2px 0 4px;
    }

    .item {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: flex-start;
        padding: 10px;
        background: var(--card-bg);
        border: 1px solid var(--border);
        border-radius: 10px;
        font-size: 12px;
        cursor: pointer;
        user-select: text;
        transition: background 0.15s, border-color 0.15s, transform 0.15s;

        &:hover {
            background: var(--card-hover-bg);
            border-color: var(--border-strong);
            transform: translateY(-1px);
        }

        .time {
            font-family: 'JetBrains Mono', Consolas, monospace;
            color: var(--text-3);
            font-size: 11px;
            flex: 0 0 auto;
        }
        .pill {
            padding: 2px 8px;
            border-radius: 999px;
            border: 1px solid var(--border);
            background: var(--surface-2);
            color: var(--text-2);
            font-size: 10px;
            font-weight: 600;
            flex: 0 0 auto;
        }
        .t {
            flex: 1 1 100%;
            color: var(--accent-2);
            font-family: 'JetBrains Mono', Consolas, monospace;
            font-size: 12px;
            line-height: 1.45;
            word-break: break-all;
        }
        .p {
            flex: 1 1 100%;
            color: var(--text-2);
            font-family: 'JetBrains Mono', Consolas, monospace;
            white-space: pre-wrap;
            word-break: break-all;
            line-height: 1.5;
            background: rgba(0, 0, 0, 0.16);
            border: 1px solid rgba(255, 255, 255, 0.04);
            border-radius: 8px;
            padding: 10px;
            max-height: 120px;
            overflow: auto;
        }
    }
}
</style>
