import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import type { AppSettings } from '@shared/types';

const DEFAULT: AppSettings = {
    autoDeleteDays: 0,
    maxMemoryMessages: 2000,
    maxPerTopic: 500,
    logDir: ''
};

export const useSettingsStore = defineStore('settings', () => {
    const state = reactive<AppSettings>({ ...DEFAULT });
    const defaultLogDir = ref('');
    const currentLogDir = ref('');

    async function load(): Promise<void> {
        const r = await window.api.settingsGet();
        if (r.success && r.data) Object.assign(state, r.data);
        const def = await window.api.settingsGetDefaultLogDir();
        const cur = await window.api.settingsGetCurrentLogDir();
        if (def.success && def.data) defaultLogDir.value = def.data;
        if (cur.success && cur.data) currentLogDir.value = cur.data;
    }

    async function save(): Promise<{ needRestart: boolean }> {
        const plain: AppSettings = {
            autoDeleteDays: state.autoDeleteDays,
            maxMemoryMessages: state.maxMemoryMessages,
            maxPerTopic: state.maxPerTopic,
            logDir: state.logDir
        };
        const r = await window.api.settingsSet(plain);
        return r.success && r.data ? r.data : { needRestart: false };
    }

    return { state, defaultLogDir, currentLogDir, load, save };
});
