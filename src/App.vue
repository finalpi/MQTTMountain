<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppHeader from './components/AppHeader.vue';
import ConnectionPanel from './components/ConnectionPanel.vue';
import SubscriptionPanel from './components/SubscriptionPanel.vue';
import PublishPanel from './components/PublishPanel.vue';
import MessageViewer from './components/MessageViewer.vue';
import HistoryPanel from './components/HistoryPanel.vue';
import PluginPanel from './components/PluginPanel.vue';
import PluginWebView from './components/PluginWebView.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import ToastHost from './components/ToastHost.vue';
import FormatViewerModal from './components/FormatViewerModal.vue';
import { useConnectionStore } from './stores/connection';
import { useMessageStore } from './stores/messages';
import { useSettingsStore } from './stores/settings';
import { usePluginStore } from './stores/plugins';
import { useMqttBridge } from './composables/useMqttBridge';
import { installPluginHostBridge } from './composables/usePluginHostBridge';
import { useToast } from './composables/useToast';
import { useFocusFix } from './composables/useFocusFix';

const conn = useConnectionStore();
const msg = useMessageStore();
const settings = useSettingsStore();
const plugins = usePluginStore();
const { start, stop } = useMqttBridge();
const toast = useToast();
useFocusFix();
let teardownPluginHostBridge: (() => void) | null = null;

type StaticMainTab = 'messages' | 'history' | 'plugins';
type MainTab = StaticMainTab | `plugin:${string}`;

const mainTab = ref<MainTab>('messages');
const leftCollapsed = ref(false);
const rightCollapsed = ref(false);

const pluginCenterViews = computed(() => plugins.centerViews);
const activePluginView = computed(() => {
    if (!mainTab.value.startsWith('plugin:')) return null;
    const id = mainTab.value.slice('plugin:'.length);
    return pluginCenterViews.value.find((view) => view.id === id) ?? null;
});

onMounted(async () => {
    await Promise.all([conn.load(), settings.load(), plugins.refresh()]);
    msg.setLimits(settings.state.maxMemoryMessages, settings.state.maxPerTopic);
    await Promise.all(
        conn.list.map(async (item) => {
            const r = await window.api.publishHistoryRead({ connectionId: item.id, limit: 50 });
            if (r.success && r.data) {
                msg.replacePublishHistory(item.id, r.data.map((row) => ({
                    topic: row.topic,
                    payload: row.payload,
                    qos: row.qos,
                    retain: row.retain,
                    time: row.time
                })));
            }
        })
    );
    start();
    teardownPluginHostBridge = installPluginHostBridge();

    window.api.onAutoDeleteDone((files) => {
        if (files > 0) toast.info(`已自动清理 ${files} 个过期日志文件`);
    });
});

onBeforeUnmount(() => {
    stop();
    teardownPluginHostBridge?.();
    teardownPluginHostBridge = null;
});
</script>

<template>
    <div class="app-root">
        <AppHeader />
        <main class="grid" :class="{ 'left-collapsed': leftCollapsed, 'right-collapsed': rightCollapsed }">
            <aside class="left">
                <ConnectionPanel />
            </aside>

            <section class="center">
                <div class="tabs">
                    <button
                        class="col-toggle"
                        :class="{ flipped: leftCollapsed }"
                        :title="leftCollapsed ? '展开左栏' : '收起左栏'"
                        @click="leftCollapsed = !leftCollapsed"
                    >‹</button>
                    <button class="tab" :class="{ active: mainTab === 'messages' }" @click="mainTab = 'messages'">实时消息</button>
                    <button class="tab" :class="{ active: mainTab === 'history' }" @click="mainTab = 'history'">历史查询</button>
                    <button
                        v-for="view in pluginCenterViews"
                        :key="view.pluginId + ':' + view.id"
                        class="tab"
                        :class="{ active: mainTab === `plugin:${view.id}` }"
                        :title="view.description || view.pluginName"
                        @click="mainTab = `plugin:${view.id}`"
                    >{{ view.name }}</button>
                    <button class="tab" :class="{ active: mainTab === 'plugins' }" @click="mainTab = 'plugins'">插件</button>
                    <span class="tab-spacer"></span>
                    <button
                        class="col-toggle"
                        :class="{ flipped: rightCollapsed }"
                        :title="rightCollapsed ? '展开右栏' : '收起右栏'"
                        @click="rightCollapsed = !rightCollapsed"
                    >›</button>
                </div>
                <div class="tab-body">
                    <MessageViewer v-show="mainTab === 'messages'" />
                    <HistoryPanel v-show="mainTab === 'history'" />
                    <PluginWebView
                        v-if="activePluginView?.type === 'web'"
                        v-show="mainTab === `plugin:${activePluginView.id}`"
                        :view="activePluginView"
                    />
                    <PluginPanel v-show="mainTab === 'plugins'" />
                </div>
            </section>

            <aside class="right">
                <SubscriptionPanel />
                <PublishPanel />
                <SettingsPanel />
            </aside>
        </main>
        <ToastHost />
        <FormatViewerModal />
    </div>
</template>

<style lang="scss" scoped>
.app-root {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.grid {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 320px minmax(0, 1fr) 360px;
    gap: 12px;
    padding: 12px;
    transition: grid-template-columns 0.22s ease;
}

.grid.left-collapsed {
    grid-template-columns: 0 minmax(0, 1fr) 360px;
    gap: 0 12px;

    .left {
        display: none;
    }
}

.grid.right-collapsed {
    grid-template-columns: 320px minmax(0, 1fr) 0;
    gap: 0 12px;

    .right {
        display: none;
    }
}

.grid.left-collapsed.right-collapsed {
    grid-template-columns: 0 minmax(0, 1fr) 0;
    gap: 0;
}

.left,
.right,
.center {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.left {
    grid-column: 1;
}

.center {
    grid-column: 2;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    gap: 0;
}

.right {
    grid-column: 3;
    overflow: hidden;
    padding-right: 2px;
}

.left {
    :deep(> .panel) {
        flex: 1;
        min-height: 0;
    }
}

.tabs {
    display: flex;
    align-items: center;
    padding: 8px 8px 0;
    gap: 4px;
    border-bottom: 1px solid var(--border);
    background: var(--head-bg);

    .tab {
        background: transparent;
        border: 1px solid transparent;
        border-bottom: none;
        padding: 8px 14px;
        color: var(--text-2);
        font-size: 13px;
        border-radius: 8px 8px 0 0;
        cursor: pointer;
        transition: color 0.15s, background 0.15s;

        &:hover {
            color: var(--text-0);
        }

        &.active {
            color: var(--text-0);
            background: var(--surface);
            border-color: var(--border);
            border-bottom: 1px solid var(--surface);
            margin-bottom: -1px;
            font-weight: 600;
        }
    }

    .tab-spacer {
        flex: 1;
    }

    .col-toggle {
        width: 26px;
        height: 26px;
        display: grid;
        place-items: center;
        border: 1px solid var(--border);
        background: var(--input-bg);
        color: var(--text-1);
        border-radius: 6px;
        font-size: 14px;
        cursor: pointer;
        transition: background 0.15s, transform 0.2s, color 0.15s;
        font-family: inherit;
        line-height: 1;

        &:hover {
            background: var(--card-hover-bg);
            color: var(--text-0);
        }

        &.flipped {
            transform: rotate(180deg);
        }
    }
}

.tab-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;

    :deep(> section.panel) {
        flex: 1;
        min-height: 0;
        border: none;
        border-radius: 0;
        background: transparent;
        backdrop-filter: none;
    }

    :deep(> section.panel > .panel-head) {
        padding: 10px 16px;
    }
}

.right {
    :deep(> .panel) {
        flex: 0 0 auto;
    }

    :deep(> .panel.open) {
        flex: 1 1 0;
        min-height: 0;
    }

    :deep(> .panel.open > .panel-body) {
        overflow-y: auto;
    }
}

.right::-webkit-scrollbar,
.left::-webkit-scrollbar {
    width: 6px;
}
</style>
