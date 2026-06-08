<script setup lang="ts">
import { computed } from 'vue';
import { useSettingsStore } from '@/stores/settings';
import { useMessageStore } from '@/stores/messages';
import { useToast } from '@/composables/useToast';
import { useUiPrefs } from '@/composables/useUiPrefs';
import { useUpdater } from '@/composables/useUpdater';

const settings = useSettingsStore();
const msg = useMessageStore();
const toast = useToast();
const { prefs, toggleRight } = useUiPrefs();
const updater = useUpdater();
const isOpen = computed(() => prefs.activeRight === 'settings');

async function save(): Promise<void> {
    const changeInfo = await window.api.settingsGetLogDirChangeInfo(settings.state.logDir);
    if (!changeInfo.success) {
        toast.error(changeInfo.message || '检查日志目录变更失败');
        return;
    }

    if (changeInfo.data?.changed && changeInfo.data.sourceFiles > 0) {
        const { sourceDir, targetDir, sourceFiles } = changeInfo.data;
        const migrate = confirm(`原日志目录中有 ${sourceFiles} 个日志文件。\n\n是否迁移到新目录？\n\n确定：迁移\n取消：继续选择是否删除原始数据`);
        if (migrate) {
            const r = await window.api.settingsMigrateLogDirData({ sourceDir, targetDir });
            if (!r.success) {
                toast.error(r.message || '迁移原始数据失败');
                return;
            }
            toast.success(`已迁移 ${r.data?.files ?? sourceFiles} 个日志文件`);
        } else if (confirm('是否删除原始日志数据？\n\n删除后无法从历史查询找回。')) {
            const r = await window.api.settingsDeleteLogDirData({ sourceDir });
            if (!r.success) {
                toast.error(r.message || '删除原始数据失败');
                return;
            }
            toast.success(`已删除 ${r.data?.files ?? sourceFiles} 个日志文件`);
        }
    }

    const r = await settings.save();
    msg.setLimits(settings.state.maxMemoryMessages, settings.state.maxPerTopic);
    toast.success('设置已保存');
    if (r.needRestart) {
        if (confirm('日志目录已变更，是否立即重启应用以生效？')) {
            await window.api.appRelaunch();
        }
    }
}

async function chooseDir(): Promise<void> {
    const r = await window.api.settingsChooseLogDir();
    if (r.success && r.data) settings.state.logDir = r.data.path;
}
function resetDir(): void {
    settings.state.logDir = '';
}
async function openDir(): Promise<void> {
    await window.api.settingsOpenLogDir(settings.state.logDir || settings.currentLogDir);
}

async function checkUpdate(): Promise<void> {
    const info = await updater.check();
    if (!info) {
        toast.error(updater.state.error || '检查更新失败');
        return;
    }
    if (info.hasUpdate) {
        toast.success(`发现新版本 v${info.latestVersion}`);
        return;
    }
    toast.info(`已是最新版本 v${info.currentVersion}`);
}

function setFontSize(v: number): void {
    prefs.fontSize = Math.min(22, Math.max(10, v));
}
</script>

<template>
    <section class="panel" :class="{ open: isOpen }">
        <div class="panel-head clickable" @click="toggleRight('settings')">
            <h2>⚙️ 设置</h2>
            <span class="spacer"></span>
            <span class="chev">{{ isOpen ? '▾' : '▸' }}</span>
        </div>
        <div v-if="isOpen" class="panel-body">
            <div class="field">
                <label>消息字号（{{ prefs.fontSize }} px）</label>
                <div class="fs-row">
                    <button class="btn btn-mini" @click="setFontSize(prefs.fontSize - 1)" title="减小">−</button>
                    <input type="range" min="10" max="22" step="1" v-model.number="prefs.fontSize" class="fs-range" />
                    <button class="btn btn-mini" @click="setFontSize(prefs.fontSize + 1)" title="增大">+</button>
                    <button class="btn btn-mini" @click="setFontSize(13)" title="恢复默认">重置</button>
                </div>
                <div class="fs-preview" :style="{ fontSize: prefs.fontSize + 'px' }">
                    示例：{ "hello": "mqtt-mountain" }
                </div>
            </div>

            <div class="field">
                <label>自动删除天数（0 = 不清理）</label>
                <input type="number" min="0" v-model.number="settings.state.autoDeleteDays" />
            </div>
            <div class="field-row">
                <div class="field">
                    <label>内存消息上限</label>
                    <input type="number" min="100" step="100" v-model.number="settings.state.maxMemoryMessages" />
                </div>
                <div class="field">
                    <label>每主题上限</label>
                    <input type="number" min="50" step="50" v-model.number="settings.state.maxPerTopic" />
                </div>
            </div>
            <div class="field">
                <label>消息日志目录（修改后需重启）</label>
                <input :value="settings.state.logDir || settings.currentLogDir" readonly />
            </div>
            <div class="btn-group">
                <button class="btn btn-mini" @click="chooseDir">浏览…</button>
                <button class="btn btn-mini" @click="resetDir">恢复默认</button>
                <button class="btn btn-mini" @click="openDir">打开</button>
            </div>
            <div class="field update-field">
                <label>软件更新</label>
                <div class="version-list">
                    <div class="version-line">
                        <span>当前版本</span>
                        <b>{{ updater.state.info ? `v${updater.state.info.currentVersion}` : '—' }}</b>
                    </div>
                    <div class="version-line">
                        <span>远端最新版本</span>
                        <b>{{ updater.state.info ? `v${updater.state.info.latestVersion}` : '未检查' }}</b>
                    </div>
                </div>
                <div class="update-row">
                    <button class="btn btn-mini" :disabled="updater.state.checking" @click="checkUpdate">
                        {{ updater.state.checking ? '检查中…' : '检查更新' }}
                    </button>
                    <button
                        v-if="updater.state.info?.hasUpdate"
                        class="btn btn-mini btn-primary"
                        @click="updater.openDownload"
                    >下载</button>
                </div>
                <div v-if="updater.state.info?.hasUpdate" class="update-tip">
                    最新版本 v{{ updater.state.info.latestVersion }}，点击下载前往 GitHub Releases。
                </div>
                <div v-else-if="updater.state.error" class="update-tip error">{{ updater.state.error }}</div>
            </div>
            <button class="btn btn-primary" @click="save" style="margin-top: 6px">💾 保存设置</button>
        </div>
    </section>
</template>

<style lang="scss" scoped>
.panel-head.clickable {
    cursor: pointer;
    user-select: none;
    &:hover {
        background: var(--card-hover-bg);
    }
    .chev {
        color: var(--text-3);
        font-size: 12px;
        margin-left: 6px;
    }
}

.fs-row {
    display: flex;
    align-items: center;
    gap: 6px;

    .fs-range {
        flex: 1;
        accent-color: var(--accent);
        background: transparent;
        padding: 0;
        border: none;
        height: 24px;
    }
}

.fs-preview {
    margin-top: 8px;
    padding: 10px 12px;
    background: var(--panel-body-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-1);
    font-family: 'JetBrains Mono', Consolas, monospace;
    line-height: 1.5;
}

.update-row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
}

.version-list {
    display: grid;
    gap: 5px;
    margin-bottom: 8px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel-body-bg);
}

.version-line {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-size: 12px;

    span {
        color: var(--text-3);
    }

    b {
        color: var(--text-0);
        font-family: 'JetBrains Mono', Consolas, monospace;
        font-weight: 700;
    }
}

.update-tip {
    margin-top: 6px;
    color: #bae6fd;
    font-size: 12px;

    &.error {
        color: #fecaca;
    }
}
</style>
