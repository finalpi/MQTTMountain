<script setup lang="ts">
import { useToast } from '@/composables/useToast';
const toast = useToast();
</script>

<template>
    <Teleport to="body">
        <div class="toast-host">
            <TransitionGroup name="toast">
                <div v-for="t in toast.state.list" :key="t.id" class="toast" :class="t.type">
                    {{ t.message }}
                </div>
            </TransitionGroup>
        </div>
    </Teleport>
</template>

<style lang="scss" scoped>
.toast-host {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-end;
    pointer-events: none;
}
.toast {
    pointer-events: all;
    padding: 9px 14px;
    border-radius: 10px;
    font-size: 13px;
    backdrop-filter: blur(10px);
    background: var(--bg-1);
    border: 1px solid var(--border-strong);
    box-shadow: var(--shadow);
    max-width: 420px;
    color: var(--text-0);

    &.info {
        border-left: 3px solid var(--accent-2);
    }
    &.success {
        border-left: 3px solid var(--success);
    }
    &.warning {
        border-left: 3px solid var(--warning);
    }
    &.error {
        border-left: 3px solid var(--danger);
    }
}
.toast-enter-from,
.toast-leave-to {
    opacity: 0;
    transform: translateX(16px);
}
.toast-enter-active,
.toast-leave-active {
    transition: all 0.2s ease;
}
</style>
