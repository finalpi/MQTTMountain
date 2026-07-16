import { onBeforeUnmount, onMounted } from 'vue';

type Inputish = HTMLInputElement | HTMLTextAreaElement;

function isTextInput(el: Element | null): el is Inputish {
    if (!el) return false;
    const tag = (el as HTMLElement).tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag !== 'INPUT') return false;
    const type = (el as HTMLInputElement).type;
    return type === 'text' || type === 'password' || type === 'search' || type === 'email' || type === 'url' || type === 'tel' || type === 'number' || type === '';
}

function restoreSpecificInput(el: Inputish): void {
    let start = 0;
    let end = 0;
    try {
        start = el.selectionStart ?? 0;
        end = el.selectionEnd ?? 0;
    } catch {
        // number input may not support selection APIs
    }

    requestAnimationFrame(() => {
        if (!el.isConnected || document.activeElement !== el) return;
        // Chromium/Electron 偶尔在窗口重新获得焦点后丢失编辑上下文。重新调用
        // focus 即可恢复，不要 blur；blur/focus 会打断下一次按键和 IME 组合输入。
        el.focus({ preventScroll: true });
        try {
            el.setSelectionRange(start, end);
        } catch {}
    });
}

function reseatFocus(): void {
    const el = document.activeElement;
    if (!isTextInput(el)) return;
    restoreSpecificInput(el);
}

export function useFocusFix(): void {
    let unsub: (() => void) | null = null;
    let focusHandler: (() => void) | null = null;
    let visHandler: (() => void) | null = null;

    onMounted(() => {
        unsub = window.api.onWindowFocused(reseatFocus);

        focusHandler = () => reseatFocus();
        window.addEventListener('focus', focusHandler);

        visHandler = () => {
            if (document.visibilityState === 'visible') reseatFocus();
        };
        document.addEventListener('visibilitychange', visHandler);
    });

    onBeforeUnmount(() => {
        unsub?.();
        if (focusHandler) window.removeEventListener('focus', focusHandler);
        if (visHandler) document.removeEventListener('visibilitychange', visHandler);
    });
}
