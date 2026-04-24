<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { PluginViewDefinition } from '@shared/plugin';

const props = defineProps<{
    view: PluginViewDefinition & { pluginId: string; pluginName: string };
}>();

const loading = ref(false);
const error = ref('');
const frameHtml = ref('');

const isWebView = computed(() => props.view.type === 'web');

function injectBridge(html: string, baseUrl: string): string {
const bridge = `
<base href="${baseUrl}">
<script>
window.MqttMountainHost = {
  api: window.parent.api,
  bridge: window.parent.__MM_PLUGIN_HOST_BRIDGE__,
  view: ${JSON.stringify({
      id: props.view.id,
      name: props.view.name,
      pluginId: props.view.pluginId,
      pluginName: props.view.pluginName
  })}
};
<\/script>`;
    if (/<head[^>]*>/i.test(html)) {
        return html.replace(/<head([^>]*)>/i, `<head$1>${bridge}`);
    }
    return `<!doctype html><html><head>${bridge}</head><body>${html}</body></html>`;
}

async function loadView(): Promise<void> {
    if (!isWebView.value) {
        error.value = '该插件视图不是自定义页面';
        frameHtml.value = '';
        return;
    }
    loading.value = true;
    error.value = '';
    try {
        const result = await window.api.pluginReadViewHtml({
            pluginId: props.view.pluginId,
            viewId: props.view.id
        });
        if (!result.success || !result.data) {
            error.value = result.message || '插件页面加载失败';
            frameHtml.value = '';
            return;
        }
        frameHtml.value = injectBridge(result.data.html, result.data.baseUrl);
    } finally {
        loading.value = false;
    }
}

watch(() => `${props.view.pluginId}:${props.view.id}:${props.view.type}`, () => {
    void loadView();
}, { immediate: true });
</script>

<template>
    <section class="panel plugin-web-view">
        <div class="panel-head">
            <div>
                <h2>{{ view.name }}</h2>
                <div class="sub">{{ view.pluginName }}</div>
            </div>
        </div>
        <div class="panel-body">
            <div v-if="loading" class="state">正在加载插件页面...</div>
            <div v-else-if="error" class="state error">{{ error }}</div>
            <iframe v-else class="plugin-frame" :srcdoc="frameHtml"></iframe>
        </div>
    </section>
</template>

<style scoped lang="scss">
.plugin-web-view {
    min-height: 0;
}

.sub {
    margin-top: 4px;
    font-size: 12px;
    color: var(--text-3);
}

.panel-body {
    flex: 1;
    min-height: 0;
    padding: 0;
}

.plugin-frame {
    width: 100%;
    height: 100%;
    border: 0;
    background: transparent;
}

.state {
    height: 100%;
    display: grid;
    place-items: center;
    color: var(--text-3);
}

.state.error {
    color: #f87171;
}
</style>
