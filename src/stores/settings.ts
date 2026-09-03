import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import type { AppSettings } from '@shared/types';

const DEFAULT: AppSettings = {
    autoDeleteDays: 0,
    maxMemoryMessages: 10000,
    maxPerTopic: 500,
    logDir: ''
};

const MAX_MEMORY_MESSAGES = 1_000_000;
const MAX_PER_TOPIC = 100_000;

function normalizeSettings(value: AppSettings): AppSettings {
    const maxMemoryMessages = Math.min(
        MAX_MEMORY_MESSAGES,
        Math.max(100, Math.trunc(Number(value.maxMemoryMessages) || DEFAULT.maxMemoryMessages))
    );
    return {
        autoDeleteDays: Math.max(0, Math.trunc(Number(value.autoDeleteDays) || 0)),
        maxMemoryMessages,
        maxPerTopic: Math.min(
            maxMemoryMessages,
            MAX_PER_TOPIC,
            Math.max(50, Math.trunc(Number(value.maxPerTopic) || DEFAULT.maxPerTopic))
        ),
        logDir: typeof value.logDir === 'string' ? value.logDir.trim() : ''
    };
}

export const useSettingsStore = defineStore('settings', () => {
    const state = reactive<AppSettings>({ ...DEFAULT });
    const defaultLogDir = ref('');
    const currentLogDir = ref('');

    async function refreshLogDirs(): Promise<void> {
        const [def, cur] = await Promise.all([
            window.api.settingsGetDefaultLogDir(),
            window.api.settingsGetCurrentLogDir()
        ]);
        if (def.success && def.data) defaultLogDir.value = def.data;
        if (cur.success && cur.data) currentLogDir.value = cur.data;
    }

    async function load(): Promise<void> {
        const [r] = await Promise.all([window.api.settingsGet(), refreshLogDirs()]);
        if (r.success && r.data) Object.assign(state, r.data);
    }

    async function save(): Promise<{ needRestart: boolean }> {
        const plain = normalizeSettings(state);
        const r = await window.api.settingsSet(plain);
        if (!r.success || !r.data) throw new Error(r.message || '设置写入失败');
        Object.assign(state, plain);
        await refreshLogDirs();
        return r.data;
    }

    return { state, defaultLogDir, currentLogDir, load, save, refreshLogDirs };
});
