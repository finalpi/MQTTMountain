import { reactive } from 'vue';

export type ToastType = 'info' | 'success' | 'warning' | 'error';
export interface ToastItem {
    id: number;
    type: ToastType;
    message: string;
}

const state = reactive<{ list: ToastItem[] }>({ list: [] });
let seq = 0;

function push(type: ToastType, message: string, duration = 2500): void {
    const item: ToastItem = { id: ++seq, type, message };
    state.list.push(item);
    setTimeout(() => {
        const idx = state.list.findIndex((x) => x.id === item.id);
        if (idx >= 0) state.list.splice(idx, 1);
    }, duration);
}

export function useToast() {
    return {
        state,
        info: (m: string) => push('info', m),
        success: (m: string) => push('success', m),
        warning: (m: string) => push('warning', m),
        error: (m: string) => push('error', m, 4000)
    };
}
