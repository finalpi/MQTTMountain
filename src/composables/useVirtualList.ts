import { ref, computed, onMounted, onBeforeUnmount, Ref } from 'vue';

/**
 * 高性能固定高度虚拟列表。
 * - 不依赖 ResizeObserver；仅用 scroll 事件 + rAF 节流
 * - overscan 可配置，默认 8
 */
export function useVirtualList<T>(opts: {
    items: Ref<T[]>;
    itemHeight: number;
    overscan?: number;
    containerRef: Ref<HTMLElement | null>;
}) {
    const itemHeight = opts.itemHeight;
    const overscan = opts.overscan ?? 8;
    const scrollTop = ref(0);
    const viewport = ref(0);

    let rafId: number | null = null;
    function onScroll(): void {
        const el = opts.containerRef.value;
        if (!el) return;
        if (rafId != null) return;
        rafId = requestAnimationFrame(() => {
            rafId = null;
            scrollTop.value = el.scrollTop;
            viewport.value = el.clientHeight;
        });
    }

    function measure(): void {
        const el = opts.containerRef.value;
        if (!el) return;
        scrollTop.value = el.scrollTop;
        viewport.value = el.clientHeight;
    }

    onMounted(() => {
        const el = opts.containerRef.value;
        if (!el) return;
        el.addEventListener('scroll', onScroll, { passive: true });
        measure();
        window.addEventListener('resize', measure);
    });
    onBeforeUnmount(() => {
        const el = opts.containerRef.value;
        if (el) el.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', measure);
    });

    const total = computed(() => opts.items.value.length);
    const totalHeight = computed(() => total.value * itemHeight);

    const start = computed(() => Math.max(0, Math.floor(scrollTop.value / itemHeight) - overscan));
    const end = computed(() =>
        Math.min(total.value, Math.ceil((scrollTop.value + viewport.value) / itemHeight) + overscan)
    );
    const visible = computed(() => opts.items.value.slice(start.value, end.value));
    const offsetY = computed(() => start.value * itemHeight);

    function scrollTo(index: number): void {
        const el = opts.containerRef.value;
        if (!el) return;
        el.scrollTop = index * itemHeight;
    }
    function scrollToBottom(): void {
        const el = opts.containerRef.value;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }
    function isNearBottom(threshold = 40): boolean {
        const el = opts.containerRef.value;
        if (!el) return true;
        return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    }

    return { total, totalHeight, start, end, visible, offsetY, scrollTo, scrollToBottom, isNearBottom, measure };
}
