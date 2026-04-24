import { reactive, watch } from 'vue';

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
const MAX_PER_KEY = 20;

interface State {
    data: Record<string, string[]>;
}

function load(): State {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const d = JSON.parse(raw) as Record<string, string[]>;
            const clean: Record<string, string[]> = {};
            for (const k of Object.keys(d)) {
                if (Array.isArray(d[k])) clean[k] = d[k].filter((x) => typeof x === 'string').slice(0, MAX_PER_KEY);
            }
            return { data: clean };
        }
    } catch {}
    return { data: {} };
}

const state = reactive<State>(load());

watch(
    () => state.data,
    (v) => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
        } catch {}
    },
    { deep: true }
);

/** 哪些 key 不记忆（每次都该是新值，不该从历史挑） */
const SKIP_KEYS = new Set(['tid', 'bid', 'ts', 'timestamp', 'now']);

function remember(key: string, value: unknown): void {
    if (!key || SKIP_KEYS.has(key)) return;
    if (value == null) return;
    const s = String(value).trim();
    if (!s) return;
    // 跳过看起来像 uuid / 时间戳的值
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return;
    if (/^\d{12,}$/.test(s)) return;
    const arr = state.data[key] ?? [];
    const filtered = arr.filter((x) => x !== s);
    filtered.unshift(s);
    state.data[key] = filtered.slice(0, MAX_PER_KEY);
}

function suggestionsFor(key: string): string[] {
    return state.data[key] ?? [];
}

function forgetKey(key: string): void {
    delete state.data[key];
}

function forgetValue(key: string, value: string): void {
    const arr = state.data[key];
    if (!arr) return;
    state.data[key] = arr.filter((x) => x !== value);
}

export function useParamMemory() {
    return { remember, suggestionsFor, forgetKey, forgetValue, state };
}
