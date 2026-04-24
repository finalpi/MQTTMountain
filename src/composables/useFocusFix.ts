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

function reseatSpecificInput(el: Inputish): void {
    let start = 0;
    let end = 0;
    try {
        start = el.selectionStart ?? 0;
        end = el.selectionEnd ?? 0;
    } catch {
        // number input may not support selection APIs
    }

    el.blur();
    requestAnimationFrame(() => {
        el.focus();
        try {
            el.setSelectionRange(start, end);
        } catch {}
    });
}

function reseatFocus(): void {
    const el = document.activeElement;
    if (!isTextInput(el)) return;
    reseatSpecificInput(el);
}

export function useFocusFix(): void {
    let unsub: (() => void) | null = null;
    let pointerHandler: ((e: PointerEvent) => void) | null = null;
    let focusHandler: (() => void) | null = null;
    let visHandler: (() => void) | null = null;
    let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

    onMounted(() => {
        unsub = window.api.onWindowFocused(reseatFocus);

        focusHandler = () => reseatFocus();
        window.addEventListener('focus', focusHandler);

        visHandler = () => {
            if (document.visibilityState === 'visible') reseatFocus();
        };
        document.addEventListener('visibilitychange', visHandler);

        // Any click into a text field gets a lightweight IME/context rebind.
        pointerHandler = (e: PointerEvent) => {
            const target = e.target as Element | null;
            if (!isTextInput(target)) return;
            requestAnimationFrame(() => reseatSpecificInput(target));
            setTimeout(() => reseatSpecificInput(target), 40);
        };
        document.addEventListener('pointerdown', pointerHandler, { capture: true });

        // Printable key presses occasionally reveal the bug first; rebind immediately.
        keydownHandler = (e: KeyboardEvent) => {
            const target = e.target as Element | null;
            if (!isTextInput(target)) return;
            if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
            if (typeof e.key !== 'string' || e.key.length !== 1) return;
            requestAnimationFrame(() => {
                if (document.activeElement === target) reseatSpecificInput(target);
            });
        };
        document.addEventListener('keydown', keydownHandler, { capture: true });
    });

    onBeforeUnmount(() => {
        unsub?.();
        if (focusHandler) window.removeEventListener('focus', focusHandler);
        if (visHandler) document.removeEventListener('visibilitychange', visHandler);
        if (pointerHandler) document.removeEventListener('pointerdown', pointerHandler, { capture: true } as EventListenerOptions);
        if (keydownHandler) document.removeEventListener('keydown', keydownHandler, { capture: true } as EventListenerOptions);
    });
}
