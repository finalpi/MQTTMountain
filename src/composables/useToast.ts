import { reactive } from 'vue';

export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface ToastAnchor {
    left: number;
    top: number;
    /** 方便调试 */
    source?: string;
}

export interface ToastItem {
    id: number;
    type: ToastType;
    message: string;
    /** 锚点坐标（视口绝对定位）。若为空则显示在视口顶部中心 */
    anchor?: ToastAnchor;
}

const state = reactive<{ list: ToastItem[] }>({ list: [] });
let seq = 0;

/**
 * 捕获最近一次发生交互的 panel 元素。
 * Toast 默认显示在该 panel 顶部中心，如果找不到就 fallback 到视口顶部中心。
 */
let lastInteractedPanel: HTMLElement | null = null;
if (typeof document !== 'undefined') {
    document.addEventListener(
        'pointerdown',
        (e) => {
            const target = e.target as HTMLElement | null;
            if (!target || !target.closest) return;
            const panel = target.closest('.panel') as HTMLElement | null;
            if (panel) lastInteractedPanel = panel;
        },
        { capture: true }
    );
}

function computeAnchor(explicitEl?: HTMLElement | null): ToastAnchor | undefined {
    const el = explicitEl || lastInteractedPanel;
    if (!el || !el.isConnected) return undefined;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return undefined;
    return {
        left: rect.left + rect.width / 2,
        top: Math.max(rect.top + 12, 12),
        source: el.querySelector('h2')?.textContent ?? undefined
    };
}

function push(type: ToastType, message: string, duration = 2500, anchorEl?: HTMLElement | null): void {
    const item: ToastItem = { id: ++seq, type, message, anchor: computeAnchor(anchorEl) };
    state.list.push(item);
    setTimeout(() => {
        const idx = state.list.findIndex((x) => x.id === item.id);
        if (idx >= 0) state.list.splice(idx, 1);
    }, duration);
}

export function useToast() {
    return {
        state,
        info: (m: string, anchor?: HTMLElement | null) => push('info', m, 2500, anchor),
        success: (m: string, anchor?: HTMLElement | null) => push('success', m, 2500, anchor),
        warning: (m: string, anchor?: HTMLElement | null) => push('warning', m, 3000, anchor),
        error: (m: string, anchor?: HTMLElement | null) => push('error', m, 4000, anchor)
    };
}
