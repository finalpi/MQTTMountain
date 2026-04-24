import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { PluginRecord, SenderDefinition, PluginViewDefinition } from '@shared/plugin';

export const usePluginStore = defineStore('plugins', () => {
    const list = ref<PluginRecord[]>([]);
    const loading = ref(false);

    async function refresh(): Promise<void> {
        loading.value = true;
        try {
            const r = await window.api.pluginList();
            if (r.success && r.data) list.value = r.data;
        } finally {
            loading.value = false;
        }
    }

    const enabledPlugins = computed(() => list.value.filter((p) => p.enabled && p.loaded));
    const hasDecoder = computed(() => enabledPlugins.value.some((p) => p.hasDecoder));
    const hasTopicLabel = computed(() => enabledPlugins.value.some((p) => p.hasTopicLabel));

    /** 所有启用插件的 senders 拍平 + 附带来源信息 */
    const allSenders = computed<(SenderDefinition & { pluginId: string; pluginName: string })[]>(() => {
        const out: (SenderDefinition & { pluginId: string; pluginName: string })[] = [];
        for (const p of enabledPlugins.value) {
            for (const s of p.senders) {
                out.push({ ...s, pluginId: p.manifest.id, pluginName: p.manifest.name });
            }
        }
        return out;
    });

    const centerViews = computed<(PluginViewDefinition & { pluginId: string; pluginName: string })[]>(() => {
        const out: (PluginViewDefinition & { pluginId: string; pluginName: string })[] = [];
        for (const p of enabledPlugins.value) {
            for (const view of p.views) {
                if (view.placement !== 'center') continue;
                out.push({ ...view, pluginId: p.manifest.id, pluginName: p.manifest.name });
            }
        }
        return out;
    });

    async function setEnabled(pluginId: string, enabled: boolean): Promise<{ ok: boolean; message?: string }> {
        const r = await window.api.pluginSetEnabled({ pluginId, enabled });
        await refresh();
        return { ok: r.success, message: r.message };
    }

    async function installFromGit(url: string, ref?: string): Promise<{ ok: boolean; message?: string }> {
        const r = await window.api.pluginInstallFromGit({ url, ref });
        await refresh();
        return { ok: r.success, message: r.message };
    }

    async function installFromPath(localPath: string): Promise<{ ok: boolean; message?: string }> {
        const r = await window.api.pluginInstallFromPath(localPath);
        await refresh();
        return { ok: r.success, message: r.message };
    }

    async function uninstall(pluginId: string): Promise<{ ok: boolean; message?: string }> {
        const r = await window.api.pluginUninstall(pluginId);
        await refresh();
        return { ok: r.success, message: r.message };
    }

    async function reload(pluginId: string): Promise<{ ok: boolean; message?: string }> {
        const r = await window.api.pluginReload(pluginId);
        await refresh();
        return { ok: r.success, message: r.message };
    }

    async function updateFromGit(pluginId: string): Promise<{ ok: boolean; message?: string }> {
        const r = await window.api.pluginUpdateFromGit(pluginId);
        await refresh();
        return { ok: r.success, message: r.message };
    }

    return {
        list,
        loading,
        enabledPlugins,
        hasDecoder,
        hasTopicLabel,
        allSenders,
        centerViews,
        refresh,
        setEnabled,
        installFromGit,
        installFromPath,
        uninstall,
        reload,
        updateFromGit
    };
});
