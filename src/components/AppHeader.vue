<script setup lang="ts">
import { computed } from 'vue';
import { useConnectionStore } from '@/stores/connection';
import { useMessageStore } from '@/stores/messages';
import { useTheme } from '@/composables/useTheme';

const conn = useConnectionStore();
const msg = useMessageStore();
const { theme, toggle: toggleTheme } = useTheme();

const topicsCount = computed(() => {
    void msg.topicsVersion;
    return msg.topics.size;
});

const stateText = computed(() => {
    switch (conn.selectedState) {
        case 'connected': return '已连接';
        case 'reconnecting': return '重连中';
        case 'offline': return '离线';
        case 'closed': return '已断开';
        case 'error': return '错误';
        default: return '未连接';
    }
});

const brokerLine = computed(() => {
    const c = conn.selected;
    if (!c) return '—';
    return `${c.protocol}${c.host}:${c.port}${(c.protocol === 'ws://' || c.protocol === 'wss://') ? (c.path || '') : ''}`;
});
</script>

<template>
    <header class="app-header">
        <div class="brand">
            <div class="logo">🔺</div>
            <div class="title">
                <div class="name">MqttMountain</div>
                <div class="subtitle">高性能 MQTT 客户端</div>
            </div>
        </div>
        <div class="connection-info">
            <div class="conn-row">
                <span class="dot" :class="conn.selectedState"></span>
                <span class="state-text">{{ stateText }}</span>
                <span class="separator">·</span>
                <span class="conn-name">{{ conn.selected?.name || '未选择连接' }}</span>
            </div>
            <div class="broker" :title="brokerLine">{{ brokerLine }}</div>
        </div>
        <div class="stats">
            <div class="stat-item">
                <div class="val">{{ msg.receiveCount }}</div>
                <div class="lbl">收到</div>
            </div>
            <div class="stat-item">
                <div class="val">{{ msg.publishCount }}</div>
                <div class="lbl">发送</div>
            </div>
            <div class="stat-item">
                <div class="val">{{ topicsCount }}</div>
                <div class="lbl">主题</div>
            </div>
            <button class="theme-toggle" :title="theme === 'dark' ? '切换为亮色' : '切换为暗色'" @click="toggleTheme">
                <span v-if="theme === 'dark'">🌙</span>
                <span v-else>☀️</span>
            </button>
        </div>
    </header>
</template>

<style lang="scss" scoped>
.app-header {
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 10px 18px;
    border-bottom: 1px solid var(--border);
    background: var(--head-bg);
    backdrop-filter: blur(8px);
}

.brand {
    display: flex;
    align-items: center;
    gap: 10px;

    .logo {
        width: 32px;
        height: 32px;
        display: grid;
        place-items: center;
        border-radius: 8px;
        background: linear-gradient(135deg, #7c5cff, #38bdf8);
        font-size: 18px;
        box-shadow: 0 8px 24px -10px rgba(124, 92, 255, 0.8);
    }
    .name {
        font-weight: 700;
        font-size: 14px;
        letter-spacing: 0.4px;
    }
    .subtitle {
        font-size: 11px;
        color: var(--text-2);
    }
}

.connection-info {
    flex: 1;
    min-width: 0;

    .conn-row {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        color: var(--text-0);
    }
    .separator {
        color: var(--text-3);
    }
    .state-text {
        font-weight: 600;
    }
    .broker {
        margin-top: 3px;
        color: var(--text-2);
        font-size: 12px;
        font-family: 'JetBrains Mono', Consolas, monospace;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
}

.stats {
    display: flex;
    gap: 18px;
    align-items: center;
}

.theme-toggle {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-0);
    font-size: 16px;
    cursor: pointer;
    margin-left: 8px;
    display: grid;
    place-items: center;
    transition: background 0.15s, transform 0.2s, border-color 0.15s;

    &:hover {
        background: var(--card-hover-bg);
        border-color: var(--border-strong);
    }
    &:active {
        transform: scale(0.95);
    }
}
.stat-item {
    text-align: center;
    min-width: 56px;
    .val {
        font-size: 18px;
        font-weight: 700;
        color: var(--accent);
        font-variant-numeric: tabular-nums;
    }
    .lbl {
        font-size: 11px;
        color: var(--text-3);
    }
}
</style>
