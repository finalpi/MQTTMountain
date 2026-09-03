<script setup lang="ts">
import { computed, ref } from 'vue';
import { useSettingsStore } from '@/stores/settings';
import { useMessageStore } from '@/stores/messages';
import { useToast } from '@/composables/useToast';
import { useUiPrefs } from '@/composables/useUiPrefs';
import { useUpdater } from '@/composables/useUpdater';
import { useStorageDiskPressure } from '@/composables/useStorageDiskPressure';
import { formatBytes } from '@/utils/format';

const settings = useSettingsStore();
const msg = useMessageStore();
const toast = useToast();
const { prefs, toggleRight } = useUiPrefs();
const updater = useUpdater();
const storagePressure = useStorageDiskPressure();
const isOpen = computed(() => prefs.activeRight === 'settings');
const saving = ref(false);
const displayLogDir = computed(() => settings.state.logDir || settings.defaultLogDir || settings.currentLogDir);
const diskPressure = computed(() => storagePressure.state.current);
const diskPressureText = computed(() => {
    const current = diskPressure.value;
    if (!current) return '磁盘空间状态等待检测';
    const free = `${formatBytes(current.freeBytes)} / ${formatBytes(current.totalBytes)}（${(current.freeRatio * 100).toFixed(1)}% 可用）`;
    if (current.level === 'critical') return `严重不足：${free}。历史写入已暂停，实时消息仍继续显示。`;
    if (current.level === 'warning') return `空间不足：${free}。请尽快清理或更换日志目录。`;
    return `空间正常：${free}`;
});

async function save(): Promise<void> {
    if (saving.value) return;
    saving.value = true;
    let completedLogAction: 'migrate' | 'delete' | null = null;
    try {
        const requestedLogDir = settings.state.logDir.trim();
        const changeInfo = await window.api.settingsGetLogDirChangeInfo(requestedLogDir);
        if (!changeInfo.success) throw new Error(changeInfo.message || '检查日志目录变更失败');

        let logAction: 'migrate' | 'delete' | null = null;
        const info = changeInfo.data;
        if (info?.changed && info.sourceFiles > 0) {
            const migrate = confirm(`原日志目录中有 ${info.sourceFiles} 个日志文件。\n\n是否迁移到新目录？\n\n确定：迁移\n取消：继续选择是否删除原始数据`);
            if (migrate) logAction = 'migrate';
            else if (confirm('是否删除原始日志数据？\n\n删除后无法从历史查询找回。')) logAction = 'delete';
        }

        if (info && logAction === 'migrate') {
            if (!info.targetDir) throw new Error('迁移目标目录为空');
            const moved = await window.api.settingsMigrateLogDirData({ sourceDir: info.sourceDir, targetDir: info.targetDir });
            if (!moved.success) throw new Error(`日志迁移阶段失败，目录未切换：${moved.message || '未知错误'}`);
            completedLogAction = 'migrate';
            settings.currentLogDir = moved.data?.targetDir || info.targetDir;
            settings.state.logDir = requestedLogDir ? settings.currentLogDir : '';
            toast.success(`已迁移 ${moved.data?.files ?? info.sourceFiles} 个日志文件`);
        } else if (info && logAction === 'delete') {
            const deleted = await window.api.settingsDeleteLogDirData({ sourceDir: info.sourceDir });
            if (!deleted.success) throw new Error(`原日志删除阶段失败，目录未切换：${deleted.message || '未知错误'}`);
            completedLogAction = 'delete';
            settings.currentLogDir = deleted.data?.targetDir || info.targetDir || settings.currentLogDir;
            settings.state.logDir = requestedLogDir ? settings.currentLogDir : '';
            toast.success(`已删除 ${deleted.data?.files ?? info.sourceFiles} 个日志文件`);
        }

        try {
            await settings.save();
        } catch (settingsError) {
            if (completedLogAction) {
                const action = completedLogAction === 'migrate' ? '迁移' : '删除并切换';
                throw new Error(`日志${action}已完成且当前目录已切换，但其他设置保存失败：${settingsError instanceof Error ? settingsError.message : String(settingsError)}`);
            }
            throw settingsError;
        }
        msg.setLimits(settings.state.maxMemoryMessages, settings.state.maxPerTopic);
        toast.success('设置已保存');
    } catch (error) {
        toast.error('保存设置失败：' + (error instanceof Error ? error.message : String(error)));
    } finally {
        saving.value = false;
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
                <input :value="displayLogDir" readonly />
            </div>
            <div
                class="disk-pressure"
                :class="diskPressure?.level || 'unknown'"
                :title="diskPressure?.logRoot || displayLogDir"
            >{{ diskPressureText }}</div>
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
            <button class="btn btn-primary" :disabled="saving" @click="save" style="margin-top: 6px">
                {{ saving ? '保存中...' : '💾 保存设置' }}
            </button>
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

.disk-pressure {
    padding: 9px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel-body-bg);
    color: var(--text-2);
    font-size: 12px;
    line-height: 1.5;

    &.warning {
        border-color: rgba(245, 158, 11, 0.45);
        background: rgba(245, 158, 11, 0.1);
        color: #fcd34d;
    }

    &.critical {
        border-color: rgba(239, 68, 68, 0.55);
        background: rgba(239, 68, 68, 0.12);
        color: #fecaca;
        font-weight: 700;
    }
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
