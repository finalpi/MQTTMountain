<script setup lang="ts" generic="T">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps<{
    items: T[];
    itemHeight: number;
    overscan?: number;
    empty?: string;
    stickToBottom?: boolean;
}>();

const containerRef = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportH = ref(0);
let rafId: number | null = null;
let pinned = true;

function onScroll(): void {
    const el = containerRef.value;
    if (!el) return;
    if (rafId != null) return;
    rafId = requestAnimationFrame(() => {
        rafId = null;
        scrollTop.value = el.scrollTop;
        viewportH.value = el.clientHeight;
        pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    });
}
function measure(): void {
    const el = containerRef.value;
    if (!el) return;
    scrollTop.value = el.scrollTop;
    viewportH.value = el.clientHeight;
}
onMounted(() => {
    const el = containerRef.value;
    if (!el) return;
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', measure);
    measure();
});
onBeforeUnmount(() => {
    const el = containerRef.value;
    if (el) el.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', measure);
});

const overscan = computed(() => props.overscan ?? 8);
const total = computed(() => props.items.length);
const totalHeight = computed(() => total.value * props.itemHeight);

const start = computed(() => Math.max(0, Math.floor(scrollTop.value / props.itemHeight) - overscan.value));
const end = computed(() =>
    Math.min(total.value, Math.ceil((scrollTop.value + viewportH.value) / props.itemHeight) + overscan.value)
);
const visible = computed(() => props.items.slice(start.value, end.value));
const offsetY = computed(() => start.value * props.itemHeight);

/** items 长度变化时，如果原本贴底则保持在底部（用于追加新消息的场景） */
watch(
    () => total.value,
    () => {
        if (!props.stickToBottom) return;
        if (!pinned) return;
        requestAnimationFrame(() => {
            const el = containerRef.value;
            if (el) el.scrollTop = el.scrollHeight;
        });
    }
);
</script>

<template>
    <div class="virtual-list" ref="containerRef">
        <div v-if="total === 0 && empty" class="empty">{{ empty }}</div>
        <div class="spacer" :style="{ height: totalHeight + 'px' }">
            <div class="window" :style="{ transform: `translateY(${offsetY}px)` }">
                <div v-for="(it, i) in visible" :key="start + i" :style="{ height: itemHeight + 'px' }" class="row">
                    <slot :item="it" :index="start + i" />
                </div>
            </div>
        </div>
    </div>
</template>

<style lang="scss" scoped>
.virtual-list {
    position: relative;
    overflow-y: auto;
    overflow-x: hidden;
    flex: 1;
    min-height: 0;
    will-change: transform;
}
.spacer {
    position: relative;
}
.window {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
}
.row {
    overflow: hidden;
}
.empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--text-3);
    font-size: 12px;
    pointer-events: none;
}
</style>
