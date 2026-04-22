<script setup lang="ts">
import { computed } from 'vue';
import { useToast, type ToastAnchor } from '@/composables/useToast';

const toast = useToast();

interface ToastGroup {
    key: string;
    anchor?: ToastAnchor;
    items: typeof toast.state.list;
}

/** 按 anchor 坐标聚合 toast，同一 anchor 位置的多条消息堆叠显示 */
const groups = computed<ToastGroup[]>(() => {
    const map = new Map<string, ToastGroup>();
    for (const t of toast.state.list) {
        const key = t.anchor ? `${Math.round(t.anchor.left)}|${Math.round(t.anchor.top)}` : '__center__';
        let g = map.get(key);
        if (!g) {
            g = { key, anchor: t.anchor, items: [] };
            map.set(key, g);
        }
        g.items.push(t);
    }
    return [...map.values()];
});

function groupStyle(g: ToastGroup): Record<string, string> {
    if (g.anchor) {
        return {
            left: g.anchor.left + 'px',
            top: g.anchor.top + 'px',
            transform: 'translate(-50%, 0)'
        };
    }
    return {
        left: '50%',
        top: '24px',
        transform: 'translateX(-50%)'
    };
}
</script>

<template>
    <Teleport to="body">
        <div
            v-for="g in groups"
            :key="g.key"
            class="toast-group"
            :style="groupStyle(g)"
        >
            <TransitionGroup name="toast">
                <div v-for="t in g.items" :key="t.id" class="toast" :class="t.type">
                    {{ t.message }}
                </div>
            </TransitionGroup>
        </div>
    </Teleport>
</template>

<style lang="scss" scoped>
.toast-group {
    position: fixed;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    pointer-events: none;
    max-width: min(90vw, 520px);
}

.toast {
    pointer-events: all;
    padding: 10px 18px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.2px;
    max-width: 100%;
    color: #fff;
    text-align: center;
    word-break: break-word;
    line-height: 1.45;
    border: 1px solid transparent;
    backdrop-filter: blur(14px) saturate(160%);

    &::before {
        content: '';
        display: inline-block;
        font-size: 14px;
        font-weight: 700;
        margin-right: 8px;
        vertical-align: -1px;
    }

    &.info {
        background: linear-gradient(135deg, #3b82f6, #0ea5e9);
        border-color: rgba(56, 189, 248, 0.55);
        box-shadow: 0 14px 32px -10px rgba(14, 165, 233, 0.55), 0 0 0 1px rgba(56, 189, 248, 0.25) inset;
        &::before { content: 'ℹ'; }
    }
    &.success {
        background: linear-gradient(135deg, #10b981, #059669);
        border-color: rgba(16, 185, 129, 0.55);
        box-shadow: 0 14px 32px -10px rgba(16, 185, 129, 0.55), 0 0 0 1px rgba(16, 185, 129, 0.25) inset;
        &::before { content: '✓'; }
    }
    &.warning {
        background: linear-gradient(135deg, #f59e0b, #d97706);
        border-color: rgba(245, 158, 11, 0.65);
        box-shadow: 0 14px 32px -10px rgba(245, 158, 11, 0.6), 0 0 0 1px rgba(245, 158, 11, 0.3) inset;
        color: #fff8eb;
        &::before { content: '⚠'; }
    }
    &.error {
        background: linear-gradient(135deg, #ef4444, #dc2626);
        border-color: rgba(239, 68, 68, 0.65);
        box-shadow: 0 16px 38px -10px rgba(239, 68, 68, 0.7), 0 0 0 1px rgba(239, 68, 68, 0.35) inset;
        animation: toast-shake 0.35s ease-out;
        &::before { content: '✕'; }
    }
}

@keyframes toast-shake {
    0%, 100% { transform: translateX(0); }
    20% { transform: translateX(-4px); }
    40% { transform: translateX(4px); }
    60% { transform: translateX(-2px); }
    80% { transform: translateX(2px); }
}

.toast-enter-from,
.toast-leave-to {
    opacity: 0;
    transform: translateY(-8px) scale(0.98);
}
.toast-enter-active,
.toast-leave-active {
    transition: all 0.2s ease;
}
.toast-leave-active {
    position: absolute;
}
</style>
