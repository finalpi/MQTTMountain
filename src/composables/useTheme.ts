import { ref, watch } from 'vue';

export type ThemeName = 'dark' | 'light';

const STORAGE_KEY = 'mm_theme';

function load(): ThemeName {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        if (v === 'dark' || v === 'light') return v;
    } catch {}
    return 'dark';
}

const theme = ref<ThemeName>(load());

function apply(t: ThemeName): void {
    document.documentElement.setAttribute('data-theme', t);
}
apply(theme.value);

watch(theme, (t) => {
    apply(t);
    try {
        localStorage.setItem(STORAGE_KEY, t);
    } catch {}
});

export function useTheme() {
    function toggle(): void {
        theme.value = theme.value === 'dark' ? 'light' : 'dark';
    }
    function set(t: ThemeName): void {
        theme.value = t;
    }
    return { theme, toggle, set };
}
