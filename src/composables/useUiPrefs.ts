import { reactive, watch } from 'vue';

/** UI 面板折叠状态 + 消息字号，持久化到 localStorage */
interface UiPrefs {
    subOpen: boolean;
    pubOpen: boolean;
    settingsOpen: boolean;
    fontSize: number;
}

const STORAGE_KEY = 'mm_ui_prefs';

function load(): UiPrefs {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const p = JSON.parse(raw) as Partial<UiPrefs>;
            return {
                subOpen: p.subOpen ?? true,
                pubOpen: p.pubOpen ?? true,
                settingsOpen: p.settingsOpen ?? false,
                fontSize: Math.min(22, Math.max(10, Number(p.fontSize) || 13))
            };
        }
    } catch {}
    return { subOpen: true, pubOpen: true, settingsOpen: false, fontSize: 13 };
}

const prefs = reactive<UiPrefs>(load());

function applyFontSize(): void {
    const f = prefs.fontSize;
    document.documentElement.style.setProperty('--fs-msg', `${f}px`);
    document.documentElement.style.setProperty('--fs-msg-meta', `${Math.max(10, f - 2)}px`);
    document.documentElement.style.setProperty('--fs-msg-topic', `${Math.max(10, f - 1)}px`);
}
applyFontSize();

watch(
    () => ({ ...prefs }),
    (v) => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
        } catch {}
        applyFontSize();
    },
    { deep: true }
);

export function useUiPrefs() {
    return { prefs };
}
