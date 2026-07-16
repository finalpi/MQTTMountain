const INPUT_BUSY_WINDOW_MS = 450;

let lastInputActivityAt = Number.NEGATIVE_INFINITY;
let compositionActive = false;
let compositionStartedAt = Number.NEGATIVE_INFINITY;

function isEditableElement(value: EventTarget | Element | null): boolean {
    if (!(value instanceof Element)) return false;
    if (value instanceof HTMLInputElement) {
        const type = value.type.toLowerCase();
        return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type);
    }
    return value instanceof HTMLTextAreaElement
        || value instanceof HTMLSelectElement
        || value instanceof HTMLElement && value.isContentEditable;
}

function activeEditableElement(): Element | null {
    const active = document.activeElement;
    return isEditableElement(active) ? active : null;
}

export function noteTextInputActivity(at = performance.now()): void {
    lastInputActivityAt = at;
}

export function isTextInputFocused(): boolean {
    return activeEditableElement() != null;
}

export function textInputBusyRemainingMs(at = performance.now()): number {
    // 防止窗口切换、组件卸载等场景漏掉 compositionend 后永久停更。
    if (compositionActive && at - compositionStartedAt <= 10_000) return INPUT_BUSY_WINDOW_MS;
    if (compositionActive) compositionActive = false;
    if (!isTextInputFocused()) return 0;
    return Math.max(0, INPUT_BUSY_WINDOW_MS - (at - lastInputActivityAt));
}

export function isTextInputBusy(at = performance.now()): boolean {
    return textInputBusyRemainingMs(at) > 0;
}

export function installTextInputActivityTracking(): () => void {
    const onKeyDown = (event: KeyboardEvent) => {
        if (isEditableElement(event.target)) noteTextInputActivity();
    };
    const onBeforeInput = (event: InputEvent) => {
        if (isEditableElement(event.target)) noteTextInputActivity();
    };
    const onCompositionStart = (event: CompositionEvent) => {
        if (!isEditableElement(event.target)) return;
        compositionActive = true;
        compositionStartedAt = performance.now();
        noteTextInputActivity();
    };
    const onCompositionEnd = (event: CompositionEvent) => {
        if (!isEditableElement(event.target)) return;
        compositionActive = false;
        noteTextInputActivity();
    };
    const onFocusOut = () => {
        compositionActive = false;
    };
    const onVisibilityChange = () => {
        if (document.visibilityState !== 'visible') compositionActive = false;
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('beforeinput', onBeforeInput, true);
    document.addEventListener('compositionstart', onCompositionStart, true);
    document.addEventListener('compositionend', onCompositionEnd, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('beforeinput', onBeforeInput, true);
        document.removeEventListener('compositionstart', onCompositionStart, true);
        document.removeEventListener('compositionend', onCompositionEnd, true);
        document.removeEventListener('focusout', onFocusOut, true);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        compositionActive = false;
    };
}
