<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { usePluginStore } from '@/stores/plugins';
import { useToast } from '@/composables/useToast';

const plugins = usePluginStore();
const toast = useToast();

const gitUrl = ref('');
const gitRef = ref('');
const localPath = ref('');
const installing = ref(false);

onMounted(() => plugins.refresh());

async function doInstallGit(): Promise<void> {
    if (!gitUrl.value.trim()) { toast.error('请填写 Git 仓库地址'); return; }
    installing.value = true;
    try {
        const r = await plugins.installFromGit(gitUrl.value.trim(), gitRef.value.trim() || undefined);
        if (r.ok) {
            toast.success('插件已安装，请启用后生效');
            gitUrl.value = '';
            gitRef.value = '';
        } else {
            toast.error(`安装失败：${r.message || ''}`);
        }
    } finally {
        installing.value = false;
    }
}

async function chooseLocalDir(): Promise<void> {
    const r = await window.api.pluginChooseLocalDir();
    if (r.success && r.data?.path) localPath.value = r.data.path;
}

async function doInstallLocal(): Promise<void> {
    if (!localPath.value.trim()) { toast.error('请填写本地插件目录'); return; }
    installing.value = true;
    try {
        const r = await plugins.installFromPath(localPath.value.trim());
        if (r.ok) {
            toast.success('本地插件已加入，可以直接热重载联调');
            localPath.value = '';
        } else {
            toast.error(`本地安装失败：${r.message || ''}`);
        }
    } finally {
        installing.value = false;
    }
}

async function onToggle(pluginId: string, enabled: boolean): Promise<void> {
    const r = await plugins.setEnabled(pluginId, enabled);
    if (!r.ok) toast.error(`切换失败：${r.message || ''}`);
}

async function onReload(pluginId: string): Promise<void> {
    const r = await plugins.reload(pluginId);
    if (r.ok) toast.success('已热重载');
    else toast.error(`重载失败：${r.message || ''}`);
}

async function onUpdate(pluginId: string): Promise<void> {
    const r = await plugins.updateFromGit(pluginId);
    if (r.ok) toast.success('已拉取最新版本');
    else toast.error(`升级失败：${r.message || ''}`);
}

async function onUninstall(pluginId: string, name: string): Promise<void> {
    if (!confirm(`确定卸载插件“${name}”？`)) return;
    const r = await plugins.uninstall(pluginId);
    if (r.ok) toast.success('已卸载');
    else toast.error(`卸载失败：${r.message || ''}`);
}

async function openDir(): Promise<void> {
    await window.api.pluginOpenDir();
}

async function copyError(text: string): Promise<void> {
    if (!text.trim()) return;
    try {
        await navigator.clipboard.writeText(text);
        toast.success('错误信息已复制');
    } catch {
        toast.error('复制失败，请手动选择文本复制');
    }
}
</script>

<template>
    <section class="panel plugin-panel">
        <div class="panel-head">
            <h2>插件管理</h2>
            <span class="spacer"></span>
            <button class="btn btn-mini" @click="openDir" title="打开插件目录">目录</button>
            <button class="btn btn-mini" @click="plugins.refresh()" :disabled="plugins.loading">刷新</button>
        </div>
        <div class="panel-body">
            <div class="install-box">
                <div class="field-row install-row">
                    <div class="field">
                        <label>Git 仓库 URL</label>
                        <input v-model="gitUrl" placeholder="https://github.com/user/my-plugin.git" />
                    </div>
                    <div class="field">
                        <label>分支 / tag</label>
                        <input v-model="gitRef" placeholder="main / v1.0.0" />
                    </div>
                </div>
                <button class="btn btn-primary" :disabled="installing" @click="doInstallGit">
                    {{ installing ? '处理中...' : '从 Git 安装' }}
                </button>
                <div class="install-hint">只安装可信来源的插件。</div>
            </div>

            <div class="install-box">
                <div class="field-row local-row">
                    <div class="field">
                        <label>本地插件目录</label>
                        <input v-model="localPath" placeholder="C:\\path\\to\\your-plugin" />
                    </div>
                    <button class="btn btn-mini" @click="chooseLocalDir">选择</button>
                </div>
                <button class="btn btn-primary" :disabled="installing" @click="doInstallLocal">
                    {{ installing ? '处理中...' : '从本地目录加入' }}
                </button>
                <div class="install-hint">适合插件本地开发，改完插件后直接点“重载”。</div>
            </div>

            <div class="plugin-list">
                <div v-if="plugins.list.length === 0" class="empty">暂无插件</div>

                <div v-for="p in plugins.list" :key="p.manifest.id" class="plugin-item">
                    <div class="head">
                        <div class="title-row">
                            <span class="name" :title="p.manifest.description">{{ p.manifest.name }}</span>
                            <span class="version">v{{ p.manifest.version }}</span>
                            <span v-if="p.manifest.author" class="author">@{{ p.manifest.author }}</span>
                        </div>
                        <div class="toggle">
                            <label class="switch" :title="p.enabled ? '禁用' : '启用'">
                                <input
                                    type="checkbox"
                                    :checked="p.enabled"
                                    @change="onToggle(p.manifest.id, ($event.target as HTMLInputElement).checked)"
                                />
                                <span class="slider" :class="{ on: p.enabled, loaded: p.loaded, errored: !!p.error }"></span>
                            </label>
                        </div>
                    </div>
                    <div v-if="p.manifest.description" class="desc">{{ p.manifest.description }}</div>
                    <div class="badges">
                        <span v-if="p.loaded" class="badge ok">已加载</span>
                        <span v-else-if="p.enabled && p.error" class="badge err">加载失败</span>
                        <span v-if="p.hasDecoder" class="badge">解码</span>
                        <span v-if="p.hasTopicLabel" class="badge">主题别名</span>
                        <span v-if="p.senders.length" class="badge">{{ p.senders.length }} 个模板</span>
                        <span v-if="p.source?.type === 'git'" class="badge git" :title="p.source.url">Git</span>
                        <span v-else-if="p.source?.type === 'path'" class="badge">本地</span>
                    </div>
                    <div v-if="p.error" class="error-box">
                        <pre class="error-line">{{ p.error }}</pre>
                        <button class="btn btn-mini" @click="copyError(p.error)">复制错误</button>
                    </div>
                    <div class="actions">
                        <button class="btn btn-mini" @click="onReload(p.manifest.id)">重载</button>
                        <button
                            v-if="p.source?.type === 'git'"
                            class="btn btn-mini"
                            @click="onUpdate(p.manifest.id)"
                        >升级</button>
                        <button
                            class="btn btn-mini btn-danger"
                            @click="onUninstall(p.manifest.id, p.manifest.name)"
                        >卸载</button>
                    </div>
                </div>
            </div>
        </div>
    </section>
</template>

<style lang="scss" scoped>
.plugin-panel {
    min-height: 0;
}

.panel-body {
    overflow-y: auto;
    gap: 14px;
}

.install-box {
    background: var(--panel-body-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;

    .install-row {
        grid-template-columns: 2fr 1fr;
    }

    .local-row {
        grid-template-columns: 1fr auto;
        align-items: end;
    }

    .install-hint {
        font-size: 11px;
        color: var(--text-3);
    }
}

.plugin-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.plugin-item {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;

    .head {
        display: flex;
        align-items: center;
        gap: 10px;
    }

    .title-row {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: baseline;
        gap: 8px;
        flex-wrap: wrap;

        .name {
            font-weight: 600;
            font-size: 13px;
            color: var(--text-0);
        }

        .version {
            font-size: 11px;
            color: var(--text-3);
            font-family: 'JetBrains Mono', Consolas, monospace;
        }

        .author {
            font-size: 11px;
            color: var(--text-3);
        }
    }

    .desc {
        color: var(--text-2);
        font-size: 12px;
        line-height: 1.5;
    }

    .badges {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
    }

    .badge {
        padding: 1px 7px;
        border-radius: 4px;
        background: var(--surface-2);
        color: var(--text-2);
        font-size: 10px;
        font-weight: 600;
        border: 1px solid var(--border);

        &.ok {
            background: rgba(16, 185, 129, 0.14);
            color: #34d399;
            border-color: rgba(16, 185, 129, 0.3);
        }

        &.err {
            background: rgba(239, 68, 68, 0.14);
            color: #f87171;
            border-color: rgba(239, 68, 68, 0.3);
        }

        &.git {
            background: rgba(124, 92, 255, 0.16);
            color: #c4b5fd;
            border-color: rgba(124, 92, 255, 0.35);
        }
    }

    .error-box {
        display: flex;
        align-items: start;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 8px;
        background: rgba(239, 68, 68, 0.08);
        border: 1px solid rgba(239, 68, 68, 0.2);
    }

    .error-line {
        flex: 1;
        margin: 0;
        color: #f87171;
        font-size: 11px;
        line-height: 1.5;
        font-family: 'JetBrains Mono', Consolas, monospace;
        word-break: break-all;
        white-space: pre-wrap;
        user-select: text;
    }

    .actions {
        display: flex;
        gap: 6px;
        margin-top: 2px;
    }
}

.switch {
    display: inline-flex;
    align-items: center;
    cursor: pointer;
    user-select: none;

    input {
        display: none;
    }

    .slider {
        width: 36px;
        height: 20px;
        border-radius: 999px;
        background: var(--border-strong);
        position: relative;
        transition: background 0.15s;

        &::after {
            content: '';
            position: absolute;
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: #fff;
            top: 2px;
            left: 2px;
            transition: left 0.15s;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
        }

        &.on {
            background: linear-gradient(135deg, #7c5cff, #5b8def);

            &::after {
                left: 18px;
            }
        }

        &.errored {
            background: #ef4444;
        }
    }
}
</style>
