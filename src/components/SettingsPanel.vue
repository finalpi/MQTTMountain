<script setup lang="ts">
import { useSettingsStore } from '@/stores/settings';
import { useMessageStore } from '@/stores/messages';
import { useToast } from '@/composables/useToast';
import { useUiPrefs } from '@/composables/useUiPrefs';

const settings = useSettingsStore();
const msg = useMessageStore();
const toast = useToast();
const { prefs } = useUiPrefs();

async function save(): Promise<void> {
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

function setFontSize(v: number): void {
    prefs.fontSize = Math.min(22, Math.max(10, v));
}
</script>

<template>
    <section class="panel" :class="{ collapsed: !prefs.settingsOpen }">
        <div class="panel-head clickable" @click="prefs.settingsOpen = !prefs.settingsOpen">
            <h2>⚙️ 设置</h2>
            <span class="spacer"></span>
            <span class="chev">{{ prefs.settingsOpen ? '▾' : '▸' }}</span>
        </div>
        <div v-if="prefs.settingsOpen" class="panel-body">
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
</style>
