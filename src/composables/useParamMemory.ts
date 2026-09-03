import { reactive, watch } from 'vue';
import { recordRendererPerf } from '@/utils/rendererPerf';

/**
 * 插件 sender 参数输入的历史记忆。
 * - 按 paramKey 全局共享（比如所有 sender 的 `sn` 参数都共用一份 SN 列表）
 * - 每个 paramKey 至多保留 `MAX_PER_KEY` 条，LRU 剔除最旧
 * - 持久化到 localStorage
 *
 * 用法：
 *   const { remember, suggestionsFor } = useParamMemory();
 *   remember('sn', '8UUXNCJ00A0XWG');
 *   const list = suggestionsFor('sn');       // 供 datalist 使用
 */

const STORAGE_KEY = 'mm_param_memory';
const MAX_PER_KEY = 100;
const MAX_KEYS = 300;
const MAX_KEY_LENGTH = 200;
const MAX_VALUE_LENGTH = 4096;

interface State {
    data: Record<string, string[]>;
}

function load(): State {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const d = JSON.parse(raw) as Record<string, string[]>;
            const clean: Record<string, string[]> = {};
            for (const k of Object.keys(d).slice(-MAX_KEYS)) {
                if (!k || k.length > MAX_KEY_LENGTH) continue;
                if (Array.isArray(d[k])) clean[k] = d[k]
                    .filter((x) => typeof x === 'string' && x.length <= MAX_VALUE_LENGTH)
                    .slice(0, MAX_PER_KEY);
            }
            return { data: clean };
        }
    } catch {}
    return { data: {} };
}

const state = reactive<State>(load());
const managedKeys = new Set<string>();
const keyOrder = Object.keys(state.data);
let suggestionsVersion = 0;

function normalizeKey(key: unknown): string {
    return typeof key === 'string' && key.length <= MAX_KEY_LENGTH ? key.trim() : '';
}

function touchKey(key: string): boolean {
    let evictedAny = false;
    const index = keyOrder.indexOf(key);
    if (index >= 0) keyOrder.splice(index, 1);
    keyOrder.push(key);
    while (keyOrder.length > MAX_KEYS) {
        const evicted = keyOrder.shift();
        if (!evicted || evicted === key) continue;
        delete state.data[evicted];
        managedKeys.delete(evicted);
        evictedAny = true;
    }
    return evictedAny;
}

watch(
    () => state.data,
    (v) => {
        const startedAt = performance.now();
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
        } catch {}
        recordRendererPerf('param-memory.persist', performance.now() - startedAt, Object.keys(v).length);
    },
    { deep: true }
);

/** 哪些 key 不记忆（每次都该是新值，不该从历史挑） */
const SKIP_KEYS = new Set(['tid', 'bid', 'ts', 'timestamp', 'now']);

function remember(key: string, value: unknown): void {
    key = normalizeKey(key);
    if (!key || SKIP_KEYS.has(key.toLowerCase())) return;
    if (value == null) return;
    const s = String(value).trim();
    if (!s || s.length > MAX_VALUE_LENGTH) return;
    // 跳过看起来像 uuid / 时间戳的值
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return;
    if (/^\d{12,}$/.test(s)) return;
    const arr = state.data[key] ?? [];
    if (managedKeys.has(key)) {
        if (arr.includes(s)) {
            if (touchKey(key)) suggestionsVersion++;
            return;
        }
        touchKey(key);
        state.data[key] = [...arr, s].slice(0, MAX_PER_KEY);
        suggestionsVersion++;
        return;
    }
    touchKey(key);
    if (arr[0] === s) return;
    const filtered = arr.filter((x) => x !== s);
    filtered.unshift(s);
    state.data[key] = filtered.slice(0, MAX_PER_KEY);
    suggestionsVersion++;
}

function suggestionsFor(key: string): string[] {
    key = normalizeKey(key);
    if (!key) return [];
    return state.data[key] ?? [];
}

function forgetKey(key: string): void {
    key = normalizeKey(key);
    const existed = Object.prototype.hasOwnProperty.call(state.data, key);
    delete state.data[key];
    managedKeys.delete(key);
    const index = keyOrder.indexOf(key);
    if (index >= 0) keyOrder.splice(index, 1);
    if (existed) suggestionsVersion++;
}

function forgetValue(key: string, value: string): void {
    const arr = state.data[key];
    if (!arr) return;
    const next = arr.filter((x) => x !== value);
    if (next.length === arr.length) return;
    state.data[key] = next;
    suggestionsVersion++;
}

function replaceKey(key: string, values: unknown[]): void {
    key = normalizeKey(key);
    if (!key || SKIP_KEYS.has(key.toLowerCase())) return;
    managedKeys.add(key);
    const evicted = touchKey(key);
    const clean: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        if (value == null) continue;
        const text = String(value).trim();
        if (!text || text.length > MAX_VALUE_LENGTH || seen.has(text)) continue;
        seen.add(text);
        clean.push(text);
        if (clean.length >= MAX_PER_KEY) break;
    }
    const previous = state.data[key] ?? [];
    const changed = previous.length !== clean.length || previous.some((value, index) => value !== clean[index]);
    if (changed) state.data[key] = clean;
    if (changed || evicted) suggestionsVersion++;
}

export function useParamMemory() {
    return {
        remember,
        suggestionsFor,
        forgetKey,
        forgetValue,
        replaceKey,
        state,
        get version() { return suggestionsVersion; }
    };
}
