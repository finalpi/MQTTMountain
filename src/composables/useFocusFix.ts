import { onMounted, onBeforeUnmount } from 'vue';

/**
 * 修复 Electron on Windows 的文本输入偶发失灵 bug。
 *
 * 现象：窗口失焦再回焦后，输入框只能执行 delete/cut/paste（命令通道），
 *   却无法接受键盘字符输入（InputEvent 通道）。
 *
 * 成因：Chromium 的 BrowserCompositor / WidgetHost 路径在焦点恢复时
 *   偶尔没把 IME context 重新绑定到当前 focused element 上。
 *
 * 修复策略：
 *   1. 收到 window:focused（主进程 focus/restore/show/did-finish-load）
 *      → 把当前 activeElement 做一次 blur→focus 反弹，强制重新绑定
 *      → 并保存并恢复原有 selection，避免光标位置丢失
 *   2. 同步监听 document 原生 visibilitychange / window focus 事件，
 *      作为主进程事件未触发时的兜底
 *   3. 在输入元素的 pointerdown 时也做一次轻量校验（最保险的第三道防线）
 */

type Inputish = HTMLInputElement | HTMLTextAreaElement;

function isTextInput(el: Element | null): el is Inputish {
    if (!el) return false;
    const tag = (el as HTMLElement).tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag !== 'INPUT') return false;
    const type = (el as HTMLInputElement).type;
    return type === 'text' || type === 'password' || type === 'search' || type === 'email' || type === 'url' || type === 'tel' || type === 'number' || type === '';
}

function reseatFocus(): void {
    const el = document.activeElement;
    if (!isTextInput(el)) return;
    let start = 0;
    let end = 0;
    try {
        start = el.selectionStart ?? 0;
        end = el.selectionEnd ?? 0;
    } catch {
        /* number input 无 selection */
    }
    el.blur();
    // 用 rAF 而不是 setTimeout(0)：下一帧前 Chromium 已处理完 focus 队列
    requestAnimationFrame(() => {
        el.focus();
        try {
            el.setSelectionRange(start, end);
        } catch {}
    });
}

export function useFocusFix(): void {
    let unsub: (() => void) | null = null;
    let pdHandler: ((e: PointerEvent) => void) | null = null;
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

        // 当鼠标点击到文本输入元素时，如果它已经是 activeElement（重复点击）
        // 也做一次轻量重绑定——覆盖用户回窗口后点击同一个 input 的场景
        pdHandler = (e: PointerEvent) => {
            const t = e.target as Element | null;
            if (isTextInput(t) && document.activeElement === t) {
                // 下一帧再弹一下，不阻塞正常点击
                requestAnimationFrame(() => reseatFocus());
            }
        };
        document.addEventListener('pointerdown', pdHandler, { capture: true });
    });

    onBeforeUnmount(() => {
        unsub?.();
        if (focusHandler) window.removeEventListener('focus', focusHandler);
        if (visHandler) document.removeEventListener('visibilitychange', visHandler);
        if (pdHandler) document.removeEventListener('pointerdown', pdHandler, { capture: true } as EventListenerOptions);
    });
}
