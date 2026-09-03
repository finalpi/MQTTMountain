<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue';
import { useConnectionStore } from '@/stores/connection';
import { useMessageStore } from '@/stores/messages';
import { useToast } from '@/composables/useToast';
import { useUiPrefs } from '@/composables/useUiPrefs';
import { usePluginStore } from '@/stores/plugins';
import { useParamMemory } from '@/composables/useParamMemory';
import { useFormatViewer } from '@/composables/useFormatViewer';
import { shortTime } from '@/utils/format';
import type { SenderDefinition, SenderParamAction } from '@shared/plugin';

const conn = useConnectionStore();
const msg = useMessageStore();
const toast = useToast();
const { prefs, toggleRight } = useUiPrefs();
const plugins = usePluginStore();
const paramMem = useParamMemory();
const formatViewer = useFormatViewer();
const isOpen = computed(() => prefs.activeRight === 'pub');

const topic = ref('test/message');
const qos = ref<0 | 1 | 2>(0);
const retain = ref(false);
const payload = ref('{"msg": "hello"}');
const payloadEl = ref<HTMLTextAreaElement | null>(null);
const publishing = ref(false);
let paramActionSeq = 0;
let senderGeneration = 0;

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

function openPayloadViewer(): void {
    formatViewer.open({
        topic: topic.value.trim() || '待发送消息',
        time: Date.now(),
        raw: payload.value,
        autoFormat: true,
        editable: true,
        publishable: true,
        connectionId: conn.selectedId,
        history: historyList.value.slice(0, 30),
        onApply: applyPayloadDraft,
        onPublish: publishPayloadDraft
    });
}

interface PayloadDraft {
    topic: string;
    raw: string;
    qos?: number;
    retain?: boolean;
}

function applyPayloadDraft(draft: PayloadDraft): void {
    topic.value = draft.topic;
    payload.value = draft.raw;
    if (draft.qos === 0 || draft.qos === 1 || draft.qos === 2) qos.value = draft.qos;
    if (typeof draft.retain === 'boolean') retain.value = draft.retain;
}

async function publishPayloadDraft(draft: PayloadDraft): Promise<void> {
    applyPayloadDraft(draft);
    await publishMessage(draft);
}

async function publishMessage(draft?: PayloadDraft): Promise<void> {
    if (publishing.value) return;
    const c = conn.selected;
    if (!c) return;
    if (!canOp.value) { toast.error('请先连接'); return; }
    const nextTopic = (draft?.topic ?? topic.value).trim();
    const nextPayload = draft?.raw ?? payload.value;
    if (!nextTopic) { toast.error('主题不能为空'); return; }
    if (/[+#]/u.test(nextTopic)) { toast.error('发布主题不能包含 MQTT 通配符 + 或 #'); return; }
    const sender = activeSender.value;
    const senderGenerationAtPublish = senderGeneration;
    const missingRequired = sender?.params?.find((param) => param.required && !String(paramValues.value[param.key] ?? '').trim());
    if (missingRequired) { toast.error(`请填写必填参数：${missingRequired.label}`); return; }

    const request = {
        connectionId: c.id,
        topic: nextTopic,
        payload: nextPayload,
        qos: qos.value,
        retain: retain.value
    } as const;
    const startedAt = Date.now();
    const rememberedParams = { ...paramValues.value };
    let sent = false;
    publishing.value = true;
    try {
        const r = await window.api.mqttPublish(request);
        if (!r.success) {
            toast.error('发送失败：' + (r.message || ''));
            return;
        }
        sent = true;
        topic.value = nextTopic;
        payload.value = nextPayload;
        const item = { topic: nextTopic, payload: nextPayload, qos: request.qos, retain: request.retain, time: startedAt };
        msg.pushPublishHistory(c.id, item);
        if (
            formatViewer.state.visible
            && formatViewer.state.editable
            && formatViewer.state.draftTopic === nextTopic
            && formatViewer.state.draftRaw === nextPayload
        ) {
            formatViewer.markPublished({ connectionId: c.id, sinceTime: item.time });
        }
        // 发送成功后把当前 sender 的参数值记入历史，下次可下拉选择
        if (sender?.params) {
            for (const pr of sender.params) {
                const value = rememberedParams[pr.key];
                paramMem.remember(pr.key, value);
                for (const key of pr.suggestionKeys ?? []) {
                    const resolved = applyTemplate(key, rememberedParams);
                    if (!resolved.includes('{')) paramMem.remember(resolved, value);
                }
            }
        }
        const [, historyResult] = await Promise.all([
            refreshMarkedParamsAfterPublish(
                sender,
                rememberedParams,
                senderGenerationAtPublish,
                nextTopic,
                nextPayload
            ),
            window.api.publishHistoryAppend({ connectionId: c.id, ...item })
        ]);
        if (!historyResult.success) {
            toast.warning('消息已发送，但发送历史保存失败：' + (historyResult.message || '未知错误'));
        } else {
            toast.success('已发送');
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (sent) toast.warning('消息已发送，但后续处理失败：' + message);
        else toast.error('发送失败：' + message);
    } finally {
        publishing.value = false;
    }
}

async function doPublish(): Promise<void> {
    await publishMessage();
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
const lastTemplateTopic = ref('');
const lastTemplatePayload = ref('');

function resolveSuggestionKey(key: string): string {
    return applyTemplate(key, paramValues.value);
}

function suggestionListFor(paramKey: string, suggestionKeys: string[] = []): string[] {
    const values = new Set<string>();
    const addAll = (items: Array<string | undefined>): void => {
        for (const item of items) {
            if (typeof item === 'string' && item.trim()) values.add(item.trim());
        }
    };

    let hasResolvedSuggestionKey = false;
    for (const key of suggestionKeys) {
        const resolved = resolveSuggestionKey(key);
        if (resolved.includes('{')) continue;
        hasResolvedSuggestionKey = true;
        addAll(paramMem.suggestionsFor(resolved));
    }
    if (!suggestionKeys.length || !hasResolvedSuggestionKey) addAll(paramMem.suggestionsFor(paramKey));

    return [...values];
}

function stableSuggestionList(previous: string[], next: string[]): string[] {
    const nextSet = new Set(next);
    const stable = previous.filter((item) => nextSet.has(item));
    for (const item of next) {
        if (!stable.includes(item)) stable.push(item);
    }
    return stable;
}

function applyTemplate(tpl: string, vals: Record<string, string>): string {
    return tpl.replace(/\{(\w+)\}/g, (_, k) => vals[k] ?? `{${k}}`);
}

function senderKey(sender: Pick<SenderDefinition, 'id'> & { pluginId: string }): string {
    return `${sender.pluginId}\u0000${sender.id}`;
}

async function refreshMarkedParamsAfterPublish(
    sender: (SenderDefinition & { pluginId: string; pluginName: string }) | null,
    publishedParams: Record<string, string>,
    expectedGeneration: number,
    publishedTopic: string,
    publishedPayload: string
): Promise<void> {
    if (!sender) return;
    const marked = (sender.params ?? []).filter((param) => param.refreshAfterPublish && param.actions?.[0]);
    if (!marked.length) return;
    const expectedKey = senderKey(sender);
    if (!activeSender.value || senderKey(activeSender.value) !== expectedKey || senderGeneration !== expectedGeneration) return;

    const results = await Promise.all(marked.map(async (param) => {
        const action = param.actions![0];
        try {
            const result = await window.api.pluginSenderParamAction({
                pluginId: sender.pluginId,
                senderId: sender.id,
                paramKey: param.key,
                actionId: action.id,
                params: {
                    ...publishedParams,
                    __paramSuggestions: JSON.stringify(paramMem.state.data)
                }
            });
            return { param, result };
        } catch (error) {
            return {
                param,
                result: { success: false, message: error instanceof Error ? error.message : String(error) }
            };
        }
    }));

    if (!activeSender.value || senderKey(activeSender.value) !== expectedKey || senderGeneration !== expectedGeneration) return;
    const patch: Record<string, string> = {};
    const failures: string[] = [];
    for (const { param, result } of results) {
        if (!result.success) {
            failures.push(`${param.label}：${result.message || '刷新失败'}`);
            continue;
        }
        const data = result.data;
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            for (const [key, value] of Object.entries(data)) patch[key] = String(value ?? '');
        } else {
            patch[param.key] = String(data ?? '');
        }
    }
    if (Object.keys(patch).length > 0) {
        Object.assign(paramValues.value, patch);
        senderGeneration++;
        for (const key of Object.keys(patch)) refreshParamSuggestions(key);
        const outputStillMatchesPublished = topic.value === publishedTopic && payload.value === publishedPayload;
        syncTemplateOutput(sender, outputStillMatchesPublished);
    }
    if (failures.length) toast.warning(`消息已发送，但刷新参数失败：${failures.join('；')}`);
}

function syncTemplateOutput(s: SenderDefinition, overwrite = true): void {
    const nextTopic = applyTemplate(s.topic, paramValues.value);
    const nextPayload = applyTemplate(s.payloadTemplate, paramValues.value);
    const canUpdateTopic = overwrite || topic.value === lastTemplateTopic.value;
    const canUpdatePayload = overwrite || payload.value === lastTemplatePayload.value;

    if (canUpdateTopic) topic.value = nextTopic;
    if (canUpdatePayload) payload.value = nextPayload;
    lastTemplateTopic.value = nextTopic;
    lastTemplatePayload.value = nextPayload;
}

function pickSender(key: string): void {
    paramActionSeq++;
    senderGeneration++;
    const s = plugins.allSenders.find((item) => senderKey(item) === key);
    if (!s) {
        activeSender.value = null;
        lastTemplateTopic.value = '';
        lastTemplatePayload.value = '';
        return;
    }
    activeSender.value = s;
    paramValues.value = {};
    paramSuggestionCache.value = {};
    for (const pr of s.params ?? []) {
        // 优先用记忆里最近一次的值，其次用插件声明的 default
        const suggestions = suggestionListFor(pr.key, pr.suggestionKeys ?? []);
        paramSuggestionCache.value[pr.key] = suggestions;
        const memo = suggestions[0];
        const initial = memo != null && memo !== '' ? memo : String(pr.default ?? '');
        paramValues.value[pr.key] = initial;
    }
    syncTemplateOutput(s);
    if (s.qos != null) qos.value = s.qos;
    if (s.retain != null) retain.value = s.retain;
}

function refreshParamSuggestions(changedKey?: string): void {
    const s = activeSender.value;
    if (!s) return;
    for (const pr of s.params ?? []) {
        const previousSuggestions = paramSuggestionCache.value[pr.key] ?? [];
        const suggestions = stableSuggestionList(previousSuggestions, suggestionListFor(pr.key, pr.suggestionKeys ?? []));
        paramSuggestionCache.value[pr.key] = suggestions;
        const dependsOnChanged = !!changedKey && (pr.suggestionKeys ?? []).some((key) => key.includes(`{${changedKey}}`));
        if (!dependsOnChanged || !suggestions.length) continue;
        const current = paramValues.value[pr.key];
        if (!current || previousSuggestions.includes(current)) {
            paramValues.value[pr.key] = suggestions[0];
        }
    }
}

function onParamInput(changedKey?: string): void {
    const s = activeSender.value;
    if (!s) return;
    senderGeneration++;
    refreshParamSuggestions(changedKey);
    syncTemplateOutput(s);
}

function onSuggestionPick(paramKey: string, value: string): void {
    if (!value) return;
    paramValues.value[paramKey] = value;
    onParamInput(paramKey);
}

function actionLabel(action: SenderParamAction): string {
    return action.label;
}

function fillParamValue(paramKey: string, value: string): void {
    paramValues.value[paramKey] = value;
    onParamInput(paramKey);
}

async function runParamAction(paramKey: string, action: SenderParamAction): Promise<void> {
    const s = activeSender.value;
    if (!s) return;
    const seq = ++paramActionSeq;
    const activeKey = senderKey(s);
    const generation = senderGeneration;
    const result = await window.api.pluginSenderParamAction({
        pluginId: s.pluginId,
        senderId: s.id,
        paramKey,
        actionId: action.id,
        params: {
            ...paramValues.value,
            __paramSuggestions: JSON.stringify(paramMem.state.data)
        }
    });
    if (seq !== paramActionSeq || generation !== senderGeneration || !activeSender.value || senderKey(activeSender.value) !== activeKey) return;
    if (!result.success) {
        toast.error(result.message || '参数动作执行失败');
        return;
    }
    const data = result.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        const changedKeys = Object.keys(data);
        for (const [key, value] of Object.entries(data)) {
            paramValues.value[key] = String(value ?? '');
        }
        for (const key of changedKeys) refreshParamSuggestions(key);
        onParamInput();
        return;
    }
    fillParamValue(paramKey, String(data ?? ''));
}

watch(
    () => paramMem.state.data,
    () => {
        const s = activeSender.value;
        if (!s) return;
        let changed = false;
        for (const pr of s.params ?? []) {
            const previousSuggestions = paramSuggestionCache.value[pr.key] ?? [];
            const suggestions = stableSuggestionList(previousSuggestions, suggestionListFor(pr.key, pr.suggestionKeys ?? []));
            const latest = suggestions[0];
            if (!latest) continue;
            const current = paramValues.value[pr.key];
            paramSuggestionCache.value[pr.key] = suggestions;
            if (!current) {
                paramValues.value[pr.key] = latest;
                changed = true;
            }
        }
        if (changed) syncTemplateOutput(s, false);
        if (changed) senderGeneration++;
    },
    { deep: true }
);

watch(
    () => plugins.allSenders,
    () => {
        const current = activeSender.value;
        if (!current) return;
        const latest = plugins.allSenders.find((item) => senderKey(item) === senderKey(current));
        if (latest) activeSender.value = latest;
        else pickSender('');
    }
);

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
                <select :value="activeSender ? senderKey(activeSender) : ''" @change="pickSender(($event.target as HTMLSelectElement).value)">
                    <option value="">— 自定义发送 —</option>
                    <optgroup v-for="g in senderGroups" :key="g.name" :label="g.name">
                        <option v-for="s in g.items" :key="senderKey(s)" :value="senderKey(s)">{{ s.name }}</option>
                    </optgroup>
                </select>
            </div>
            <div v-if="activeSender && (activeSender.params?.length ?? 0) > 0" class="sender-params">
                <div v-for="p in activeSender.params" :key="p.key" class="field">
                    <label>
                        <span>{{ p.label }}{{ p.required ? ' *' : '' }}</span>
                        <span class="param-actions">
                            <span
                                v-if="p.type !== 'select' && (paramSuggestionCache[p.key] ?? []).length"
                                class="mem-tag"
                                :title="(paramSuggestionCache[p.key] ?? []).join('\n')"
                            >🕘 {{ (paramSuggestionCache[p.key] ?? []).length }} 条历史</span>
                            <button
                                v-for="action in (p.actions ?? [])"
                                :key="action.id"
                                type="button"
                                class="btn btn-mini param-action"
                                @click="runParamAction(p.key, action)"
                            >{{ actionLabel(action) }}</button>
                        </span>
                    </label>
                    <select
                        v-if="p.type === 'select' && (p.options?.length || (paramSuggestionCache[p.key] ?? []).length)"
                        v-model="paramValues[p.key]"
                        @change="onParamInput(p.key)"
                    >
                        <option v-for="opt in (p.options?.length ? p.options : (paramSuggestionCache[p.key] ?? []))" :key="opt" :value="opt">{{ opt }}</option>
                    </select>
                    <select
                        v-else-if="p.type !== 'number' && (paramSuggestionCache[p.key] ?? []).length"
                        class="suggestion-select"
                        :value="(paramSuggestionCache[p.key] ?? []).includes(paramValues[p.key]) ? paramValues[p.key] : ''"
                        @change="onSuggestionPick(p.key, ($event.target as HTMLSelectElement).value)"
                    >
                        <option value="" disabled>选择历史</option>
                        <option v-for="v in (paramSuggestionCache[p.key] ?? [])" :key="v" :value="v">{{ v }}</option>
                    </select>
                    <input
                        v-else
                        :type="p.type === 'number' ? 'number' : 'text'"
                        v-model="paramValues[p.key]"
                        :placeholder="p.placeholder"
                        @input="onParamInput(p.key)"
                        @focus="paramSuggestionCache[p.key] = suggestionListFor(p.key, p.suggestionKeys ?? [])"
                    />
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
                    <span class="payload-actions">
                        <span class="msg-hint">右键放大/格式化</span>
                        <button class="btn btn-mini btn-ghost" @click="openPayloadViewer">放大</button>
                        <button class="btn btn-mini btn-ghost" @click="tryFormat">🪄 格式化</button>
                    </span>
                </label>
                <textarea
                    ref="payloadEl"
                    v-model="payload"
                    rows="10"
                    spellcheck="false"
                    title="右键放大/格式化"
                    :class="['payload-input', `is-${jsonStatus.level}`]"
                    @contextmenu.prevent="openPayloadViewer"
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
            <button class="btn btn-primary" :disabled="publishing || !canOp" @click="doPublish">
                {{ publishing ? '发布中...' : '发布' }}
            </button>

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
    .param-actions {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex: 0 0 auto;
    }
    .param-action {
        min-height: 22px;
        padding: 0 7px;
        font-size: 10px;
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

.payload-actions {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
}

.msg-hint {
    color: var(--text-3);
    font-size: 10px;
    font-weight: 500;
}

.payload-input {
    min-height: 240px;
    resize: vertical;
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
