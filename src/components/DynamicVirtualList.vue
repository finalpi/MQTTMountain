<script setup lang="ts" generic="T">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useDynamicVirtualList, type DynamicVirtualKey, type DynamicVirtualRow } from '@/composables/useDynamicVirtualList';

const props = withDefaults(defineProps<{
    items: T[];
    itemKey: (item: T, index: number) => DynamicVirtualKey;
    estimateSize: (item: T, index: number) => number;
    overscanPx?: number;
    gap?: number;
    empty?: string;
    stickToStart?: boolean;
    resetKey?: string | number | null;
    layoutKey?: string | number | null;
}>(), {
    overscanPx: 600,
    gap: 6,
    empty: '',
    stickToStart: false,
    resetKey: null,
    layoutKey: null
});

const emit = defineEmits<{
    scroll: [metrics: { scrollTop: number; clientHeight: number; scrollHeight: number }];
    userInteraction: [intent: 'toward-start' | 'toward-end' | 'direct'];
}>();

const containerRef = ref<HTMLElement | null>(null);
const itemsRef = computed(() => props.items);
const overscanPxRef = computed(() => props.overscanPx);
const gapRef = computed(() => props.gap);
const stickToStartRef = computed(() => props.stickToStart);

const virtual = useDynamicVirtualList({
    items: itemsRef,
    containerRef,
    itemKey: props.itemKey,
    estimateSize: props.estimateSize,
    overscanPx: overscanPxRef,
    gap: gapRef,
    stickToStart: stickToStartRef
});

const verticalPadding = 6;
let containerResizeObserver: ResizeObserver | null = null;
let lastWidth = 0;
let scrollEmitRaf: number | null = null;

function emitScroll(): void {
    const el = containerRef.value;
    if (!el) return;
    emit('scroll', {
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight
    });
}

function scheduleEmitScroll(): void {
    if (scrollEmitRaf != null) return;
    scrollEmitRaf = requestAnimationFrame(() => {
        scrollEmitRaf = null;
        emitScroll();
    });
}

function onScroll(): void {
    virtual.onScroll();
    scheduleEmitScroll();
}

function onWheel(event: WheelEvent): void {
    if (event.deltaY < 0) emit('userInteraction', 'toward-start');
    else if (event.deltaY > 0) emit('userInteraction', 'toward-end');
}

function onDirectUserInteraction(): void {
    emit('userInteraction', 'direct');
}

function rowStyle(row: DynamicVirtualRow<T>): Record<string, string> {
    return {
        transform: `translateY(${row.top + verticalPadding}px)`
    };
}

function setRowRef(row: DynamicVirtualRow<T>, el: Element | object | null): void {
    virtual.setRowElement(row.key, el instanceof HTMLElement ? el : null);
}

watch(
    () => props.items,
    () => {
        virtual.handleItemsChanged();
        void nextTick(emitScroll);
    }
);

watch(
    () => props.resetKey,
    () => {
        virtual.resetMeasurements(true);
        void nextTick(emitScroll);
    }
);

watch(
    () => props.layoutKey,
    () => {
        virtual.handleLayoutChanged();
        void nextTick(emitScroll);
    }
);

watch(
    () => props.stickToStart,
    (stick) => {
        if (stick) virtual.scrollToTop(false);
    }
);

watch(
    () => virtual.totalHeight.value,
    () => {
        if (props.stickToStart) virtual.scrollToTop(false);
        void nextTick(emitScroll);
    }
);

onMounted(() => {
    virtual.measure();
    virtual.syncSnapshot();
    emitScroll();
    if (typeof ResizeObserver !== 'undefined' && containerRef.value) {
        lastWidth = containerRef.value.clientWidth;
        containerResizeObserver = new ResizeObserver(() => {
            const el = containerRef.value;
            if (!el) return;
            const width = el.clientWidth;
            if (Math.abs(width - lastWidth) < 1) return;
            lastWidth = width;
            virtual.handleLayoutChanged();
        });
        containerResizeObserver.observe(containerRef.value);
    }
});

onBeforeUnmount(() => {
    containerResizeObserver?.disconnect();
    if (scrollEmitRaf != null) cancelAnimationFrame(scrollEmitRaf);
});

function getScrollElement(): HTMLElement | null {
    return virtual.getScrollElement();
}
function scrollToTop(smooth = true): void {
    virtual.scrollToTop(smooth);
    void nextTick(emitScroll);
}
function measure(): void {
    virtual.measure();
    emitScroll();
}
function resetMeasurements(scrollTopAfterReset = true): void {
    virtual.resetMeasurements(scrollTopAfterReset);
    void nextTick(emitScroll);
}
function isNearStart(threshold?: number): boolean {
    return virtual.isNearStart(threshold);
}
function isNearEnd(threshold?: number): boolean {
    return virtual.isNearEnd(threshold);
}

defineExpose({
    getScrollElement,
    scrollToTop,
    measure,
    resetMeasurements,
    isNearStart,
    isNearEnd
});
</script>

<template>
    <div
        ref="containerRef"
        class="dynamic-virtual-list"
        @scroll.passive="onScroll"
        @wheel.passive="onWheel"
        @pointerdown="onDirectUserInteraction"
        @touchstart.passive="onDirectUserInteraction"
    >
        <div v-if="items.length === 0 && empty" class="empty">{{ empty }}</div>
        <div class="dynamic-virtual-spacer" :style="{ height: virtual.totalHeight.value + verticalPadding * 2 + 'px' }">
            <div
                v-for="row in virtual.virtualRows.value"
                :key="row.key"
                :ref="(el) => setRowRef(row, el)"
                class="dynamic-virtual-row"
                :style="rowStyle(row)"
            >
                <slot :item="row.item" :index="row.index" />
            </div>
        </div>
        <slot name="after" />
    </div>
</template>

<style lang="scss" scoped>
.dynamic-virtual-list {
    position: relative;
    overflow-y: auto;
    overflow-x: hidden;
    flex: 1;
    min-height: 0;
    contain: strict;
}

.dynamic-virtual-spacer {
    position: relative;
    min-height: 0;
}

.dynamic-virtual-row {
    position: absolute;
    left: 6px;
    right: 6px;
    top: 0;
    will-change: transform;
}
</style>
