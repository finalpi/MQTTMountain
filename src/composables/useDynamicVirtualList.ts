import { computed, nextTick, onBeforeUnmount, ref, type Ref } from 'vue';

export type DynamicVirtualKey = string | number;

export interface DynamicVirtualRow<T> {
    item: T;
    index: number;
    key: DynamicVirtualKey;
    top: number;
    size: number;
}

export interface DynamicVirtualListOptions<T> {
    items: Ref<T[]>;
    containerRef: Ref<HTMLElement | null>;
    itemKey: (item: T, index: number) => DynamicVirtualKey;
    estimateSize: (item: T, index: number) => number;
    overscanPx: Ref<number>;
    gap: Ref<number>;
    stickToStart: Ref<boolean>;
}

interface LayoutRow<T> {
    item: T;
    index: number;
    key: DynamicVirtualKey;
    top: number;
    size: number;
}

interface Layout<T> {
    rows: LayoutRow<T>[];
    prefix: number[];
    totalHeight: number;
}

interface Anchor {
    key: DynamicVirtualKey;
    offset: number;
}

function clamp(n: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, n));
}

function entryHeight(entry: ResizeObserverEntry): number {
    const box = entry.borderBoxSize;
    if (box?.length) return box[0].blockSize;
    return entry.contentRect.height;
}

export function useDynamicVirtualList<T>(opts: DynamicVirtualListOptions<T>) {
    const scrollTop = ref(0);
    const viewportHeight = ref(0);
    const containerWidth = ref(0);
    const sizeVersion = ref(0);

    const measured = new Map<DynamicVirtualKey, number>();
    const elements = new Map<DynamicVirtualKey, HTMLElement>();
    const elementKeys = new WeakMap<Element, DynamicVirtualKey>();
    let resizeObserver: ResizeObserver | null = null;
    let scrollRaf: number | null = null;
    let restoreRaf: number | null = null;
    let userScrollInteractionTimer: ReturnType<typeof setTimeout> | null = null;
    let userScrollInteraction = false;
    let scrollVersion = 0;
    let snapshotKeys: DynamicVirtualKey[] = [];
    let snapshotPrefix: number[] = [0];

    const layout = computed<Layout<T>>(() => {
        void sizeVersion.value;
        const items = opts.items.value;
        const gap = Math.max(0, opts.gap.value || 0);
        const rows: LayoutRow<T>[] = new Array(items.length);
        const prefix: number[] = new Array(items.length + 1);
        prefix[0] = 0;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const key = opts.itemKey(item, i);
            const contentSize = measured.get(key) ?? Math.max(1, opts.estimateSize(item, i) || 1);
            const size = Math.max(1, contentSize) + (i < items.length - 1 ? gap : 0);
            const top = prefix[i];
            rows[i] = { item, index: i, key, top, size };
            prefix[i + 1] = top + size;
        }
        return { rows, prefix, totalHeight: prefix[items.length] ?? 0 };
    });

    function syncSnapshot(): void {
        const l = layout.value;
        snapshotKeys = l.rows.map((row) => row.key);
        snapshotPrefix = l.prefix.slice();
    }

    function markUserScrollInteraction(): void {
        userScrollInteraction = true;
        if (userScrollInteractionTimer != null) clearTimeout(userScrollInteractionTimer);
        userScrollInteractionTimer = setTimeout(() => {
            userScrollInteractionTimer = null;
            userScrollInteraction = false;
        }, 160);
    }

    function findIndexByOffset(prefix: number[], count: number, offset: number): number {
        if (count <= 0) return 0;
        const target = Math.max(0, offset);
        let lo = 0;
        let hi = count - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (prefix[mid + 1] < target) lo = mid + 1;
            else hi = mid;
        }
        return clamp(lo, 0, count - 1);
    }

    const startIndex = computed(() => {
        const l = layout.value;
        return findIndexByOffset(l.prefix, l.rows.length, scrollTop.value - opts.overscanPx.value);
    });

    const endIndex = computed(() => {
        const l = layout.value;
        if (!l.rows.length) return 0;
        const bottom = scrollTop.value + viewportHeight.value + opts.overscanPx.value;
        return Math.min(l.rows.length, findIndexByOffset(l.prefix, l.rows.length, bottom) + 1);
    });

    const virtualRows = computed<DynamicVirtualRow<T>[]>(() => {
        const l = layout.value;
        const out: DynamicVirtualRow<T>[] = [];
        for (let i = startIndex.value; i < endIndex.value; i++) {
            const row = l.rows[i];
            if (!row) continue;
            out.push(row);
        }
        return out;
    });

    function keyTop(key: DynamicVirtualKey): number | null {
        const l = layout.value;
        const row = l.rows.find((item) => item.key === key);
        return row ? row.top : null;
    }

    function captureAnchorFrom(keys: DynamicVirtualKey[], prefix: number[]): Anchor | null {
        const el = opts.containerRef.value;
        if (!el || keys.length === 0) return null;
        const index = findIndexByOffset(prefix, keys.length, el.scrollTop);
        const key = keys[index];
        if (key == null) return null;
        return { key, offset: el.scrollTop - (prefix[index] ?? 0) };
    }

    function captureAnchor(): Anchor | null {
        const l = layout.value;
        return captureAnchorFrom(l.rows.map((row) => row.key), l.prefix);
    }

    function restoreAnchor(anchor: Anchor | null): void {
        const el = opts.containerRef.value;
        if (!el) return;
        if (opts.stickToStart.value) {
            el.scrollTop = 0;
            updateViewport();
            syncSnapshot();
            return;
        }
        if (!anchor) {
            updateViewport();
            syncSnapshot();
            return;
        }
        const top = keyTop(anchor.key);
        if (top == null) {
            el.scrollTop = clamp(el.scrollTop, 0, Math.max(0, el.scrollHeight - el.clientHeight));
        } else {
            el.scrollTop = clamp(top + anchor.offset, 0, Math.max(0, el.scrollHeight - el.clientHeight));
        }
        updateViewport();
        syncSnapshot();
    }

    function scheduleRestore(anchor: Anchor | null): void {
        const versionAtSchedule = scrollVersion;
        if (restoreRaf != null) cancelAnimationFrame(restoreRaf);
        void nextTick(() => {
            restoreRaf = requestAnimationFrame(() => {
                restoreRaf = null;
                if (!opts.stickToStart.value && (versionAtSchedule !== scrollVersion || userScrollInteraction)) {
                    updateViewport();
                    syncSnapshot();
                    return;
                }
                restoreAnchor(anchor);
            });
        });
    }

    function pruneMeasurements(): void {
        const keys = new Set(layout.value.rows.map((row) => row.key));
        let changed = false;
        for (const key of measured.keys()) {
            if (keys.has(key)) continue;
            measured.delete(key);
            changed = true;
        }
        if (changed) sizeVersion.value++;
    }

    function updateViewport(): void {
        const el = opts.containerRef.value;
        if (!el) return;
        const nextScrollTop = el.scrollTop;
        if (Math.abs(nextScrollTop - scrollTop.value) >= 1) scrollVersion++;
        scrollTop.value = nextScrollTop;
        viewportHeight.value = el.clientHeight;
        containerWidth.value = el.clientWidth;
    }

    function onScroll(): void {
        markUserScrollInteraction();
        if (scrollRaf != null) return;
        scrollRaf = requestAnimationFrame(() => {
            scrollRaf = null;
            updateViewport();
        });
    }

    function measure(): void {
        updateViewport();
        syncSnapshot();
    }

    function getResizeObserver(): ResizeObserver | null {
        if (typeof ResizeObserver === 'undefined') return null;
        if (resizeObserver) return resizeObserver;
        resizeObserver = new ResizeObserver((entries) => {
            if (!entries.length) return;
            const anchor = opts.stickToStart.value ? null : captureAnchor();
            let changed = false;
            for (const entry of entries) {
                const key = elementKeys.get(entry.target);
                if (key == null) continue;
                const next = Math.ceil(entryHeight(entry));
                if (!Number.isFinite(next) || next <= 0) continue;
                const prev = measured.get(key);
                if (prev != null && Math.abs(prev - next) < 1) continue;
                measured.set(key, next);
                changed = true;
            }
            if (!changed) return;
            sizeVersion.value++;
            scheduleRestore(anchor);
        });
        return resizeObserver;
    }

    function setRowElement(key: DynamicVirtualKey, el: HTMLElement | null): void {
        const ro = getResizeObserver();
        const prev = elements.get(key);
        if (prev && prev !== el) ro?.unobserve(prev);
        if (!el) {
            if (prev) elements.delete(key);
            return;
        }
        elements.set(key, el);
        elementKeys.set(el, key);
        ro?.observe(el);
        const height = Math.ceil(el.getBoundingClientRect().height);
        if (height > 0 && measured.get(key) !== height) {
            measured.set(key, height);
            sizeVersion.value++;
        }
    }

    function handleItemsChanged(): void {
        const anchor = opts.stickToStart.value ? null : captureAnchorFrom(snapshotKeys, snapshotPrefix);
        pruneMeasurements();
        if (opts.stickToStart.value) {
            // Realtime lists can change again before the next animation frame.
            // Updating the viewport/snapshot synchronously prevents a continuous
            // message stream from indefinitely cancelling the pending restore.
            updateViewport();
            syncSnapshot();
            return;
        }
        scheduleRestore(anchor);
    }

    function resetMeasurements(scrollTopAfterReset = true): void {
        measured.clear();
        sizeVersion.value++;
        void nextTick(() => {
            const el = opts.containerRef.value;
            if (el && scrollTopAfterReset) el.scrollTop = 0;
            updateViewport();
            syncSnapshot();
        });
    }

    function handleLayoutChanged(): void {
        const anchor = opts.stickToStart.value ? null : captureAnchor();
        measured.clear();
        sizeVersion.value++;
        scheduleRestore(anchor);
    }

    function scrollToTop(smooth = true): void {
        const el = opts.containerRef.value;
        if (!el) return;
        userScrollInteraction = false;
        if (userScrollInteractionTimer != null) {
            clearTimeout(userScrollInteractionTimer);
            userScrollInteractionTimer = null;
        }
        el.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
        if (!smooth) updateViewport();
    }

    function scrollToOffset(offset: number): void {
        const el = opts.containerRef.value;
        if (!el) return;
        userScrollInteraction = false;
        if (userScrollInteractionTimer != null) {
            clearTimeout(userScrollInteractionTimer);
            userScrollInteractionTimer = null;
        }
        el.scrollTop = Math.max(0, offset);
        updateViewport();
    }

    function getScrollElement(): HTMLElement | null {
        return opts.containerRef.value;
    }

    function isNearStart(threshold = 60): boolean {
        const el = opts.containerRef.value;
        return !el || el.scrollTop <= threshold;
    }

    function isNearEnd(threshold = 160): boolean {
        const el = opts.containerRef.value;
        if (!el) return false;
        return el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
    }

    onBeforeUnmount(() => {
        if (scrollRaf != null) cancelAnimationFrame(scrollRaf);
        if (restoreRaf != null) cancelAnimationFrame(restoreRaf);
        if (userScrollInteractionTimer != null) clearTimeout(userScrollInteractionTimer);
        resizeObserver?.disconnect();
    });

    return {
        scrollTop,
        viewportHeight,
        containerWidth,
        totalHeight: computed(() => layout.value.totalHeight),
        virtualRows,
        onScroll,
        measure,
        setRowElement,
        handleItemsChanged,
        handleLayoutChanged,
        resetMeasurements,
        scrollToTop,
        scrollToOffset,
        getScrollElement,
        isNearStart,
        isNearEnd,
        syncSnapshot
    };
}
