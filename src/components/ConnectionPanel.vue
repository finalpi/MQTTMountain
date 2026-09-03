<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { normalizeConnectionConfig, useConnectionStore } from '@/stores/connection';
import { useMessageStore } from '@/stores/messages';
import { useToast } from '@/composables/useToast';
import { useSubscriptionSync } from '@/composables/useSubscriptionSync';
import type { ConnectionConfig, MqttProtocol } from '@shared/types';
import { randomClientId } from '@/utils/format';

const conn = useConnectionStore();
const msg = useMessageStore();
const toast = useToast();
const { sync: syncSubs, reset: resetSubs } = useSubscriptionSync();

const showPassword = ref(false);
const connecting = ref(false);
const connectingId = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
let connectAttemptToken = 0;
let selectAttemptToken = 0;

const selected = computed(() => conn.selected);
const isConnected = computed(() => conn.selectedState === 'connected' || conn.selectedState === 'reconnecting');
const isWs = computed(() => selected.value?.protocol === 'ws://' || selected.value?.protocol === 'wss://');

function defaultPortFor(p: MqttProtocol): number {
    switch (p) {
        case 'mqtt://': return 1883;
        case 'mqtts://': return 8883;
        case 'ws://': return 8083;
        case 'wss://': return 8084;
    }
}

function onProtocolChange(v: MqttProtocol): void {
    if (!selected.value) return;
    const prevPort = selected.value.port;
    const prevDefault = defaultPortFor(selected.value.protocol);
    const patch: Record<string, unknown> = { protocol: v };
    if (!prevPort || prevPort === prevDefault) patch.port = defaultPortFor(v);
    conn.update(selected.value.id, patch);
}

async function saveConfig(): Promise<void> {
    try {
        await conn.persist();
        toast.success('配置已保存');
    } catch (e) {
        toast.error('保存失败：' + (e as Error).message);
    }
}

async function doConnect(): Promise<void> {
    const selectedConfig = selected.value;
    const c = selectedConfig ? JSON.parse(JSON.stringify(selectedConfig)) as ConnectionConfig : null;
    if (!c) return;
    if (!c.host) { toast.error('请填写服务器地址'); return; }
    if (!c.port) { toast.error('请填写端口'); return; }
    if (connecting.value) return;

    const attemptToken = ++connectAttemptToken;
    connecting.value = true;
    connectingId.value = c.id;
    const label = c.name || `${c.host}:${c.port}`;
    const wasDirty = conn.dirty;
    try {
        await conn.persist();
        if (attemptToken !== connectAttemptToken || !conn.list.some((item) => item.id === c.id)) return;
        conn.setState(c.id, 'reconnecting');
        const r = await window.api.mqttConnect({
            connectionId: c.id,
            protocol: c.protocol,
            host: c.host,
            port: Number(c.port),
            path: c.path,
            username: c.username,
            password: c.password,
            clientId: c.clientId,
            disabledTopics: [...c.disabledTopics]
        });
        if (attemptToken !== connectAttemptToken) return;
        if (!r.success) {
            toast.error(`连接失败（${label}）：${r.message || '未知错误'}`);
            conn.setState(c.id, 'error', r.message);
            return;
        }
        const displayPaused = msg.bucketFor(c.id).paused;
        const displayResult = await window.api.mqttSetDisplayPaused({ connectionId: c.id, paused: displayPaused });
        if (!displayResult.success) throw new Error(displayResult.message || '恢复显示状态失败');
        resetSubs(c.id);
        const syncResult = await syncSubs(c, true);
        if (attemptToken !== connectAttemptToken) return;
        if (!syncResult.ok) {
            await window.api.mqttDisconnect(c.id);
            resetSubs(c.id);
            const message = syncResult.errors.join('；');
            conn.setState(c.id, 'error', message);
            toast.error(`连接后订阅同步失败（${label}）：${message}`);
            return;
        }

        toast.success(wasDirty ? `已连接：${label}（配置已自动保存）` : `已连接：${label}`);
    } catch (error) {
        if (attemptToken === connectAttemptToken) {
            const message = error instanceof Error ? error.message : String(error);
            conn.setState(c.id, 'error', message);
            toast.error(`连接失败（${label}）：${message}`);
        }
    } finally {
        if (attemptToken === connectAttemptToken) {
            connecting.value = false;
            connectingId.value = null;
        }
    }
}

async function doDisconnect(): Promise<void> {
    const c = selected.value;
    if (!c) return;
    connectAttemptToken++;
    connecting.value = false;
    const label = c.name || `${c.host}:${c.port}`;
    const result = await window.api.mqttDisconnect(c.id);
    if (!result.success) {
        toast.error(`断开失败（${label}）：${result.message || '未知错误'}`);
        return;
    }
    conn.setState(c.id, 'closed');
    resetSubs(c.id);
    toast.info(`已断开：${label}`);
}

async function newConn(): Promise<void> {
    const previousSelectedId = conn.selectedId;
    const previousDirty = conn.dirty;
    const c = conn.create();
    try {
        await conn.persist();
        toast.success('已新增连接：' + c.name);
    } catch (error) {
        const index = conn.list.findIndex((item) => item.id === c.id);
        if (index >= 0) conn.list.splice(index, 1);
        conn.selectedId = previousSelectedId;
        conn.touch();
        conn.dirty = previousDirty;
        toast.error('新增连接失败：' + (error instanceof Error ? error.message : String(error)));
    }
}

async function selectConn(id: string): Promise<void> {
    const attempt = ++selectAttemptToken;
    const previousSelectedId = conn.selectedId;
    const previousDirty = conn.dirty;
    conn.select(id);
    if (conn.selectedId === previousSelectedId) return;
    try {
        await conn.persist();
    } catch (error) {
        if (attempt !== selectAttemptToken) return;
        conn.selectedId = previousSelectedId;
        conn.touch();
        conn.dirty = previousDirty;
        toast.error('保存当前选择失败：' + (error instanceof Error ? error.message : String(error)));
    }
}

async function removeConn(id: string): Promise<void> {
    if (!confirm('确定删除这个连接配置？关联的本地历史日志也会被清理，此操作不可撤销。')) return;
    if (connectingId.value === id) {
        connectAttemptToken++;
        connecting.value = false;
        connectingId.value = null;
    }
    const disconnectResult = await window.api.mqttDisconnect(id);
    if (!disconnectResult.success) {
        toast.error('删除前断开连接失败：' + (disconnectResult.message || '未知错误'));
        return;
    }
    const index = conn.list.findIndex((item) => item.id === id);
    if (index < 0) return;
    const removed = JSON.parse(JSON.stringify(conn.list[index])) as ConnectionConfig;
    const previousSelectedId = conn.selectedId;
    const previousDirty = conn.dirty;
    conn.remove(id);
    try {
        await conn.persist();
        resetSubs(id);
        msg.dropBucket(id, true);
        toast.success('连接配置已删除');
    } catch (error) {
        conn.list.splice(index, 0, removed);
        conn.selectedId = previousSelectedId;
        conn.touch();
        let restored = false;
        try {
            await conn.persist();
            restored = true;
        } catch {
            conn.dirty = true;
        }
        if (restored) conn.dirty = previousDirty;
        const suffix = restored ? '，配置已回滚' : '，配置回滚仍待保存';
        toast.error('删除连接失败：' + (error instanceof Error ? error.message : String(error)) + suffix);
    }
}

async function duplicateConn(id: string): Promise<void> {
    try {
        const c = await conn.duplicate(id);
        if (c) toast.success('已复制连接：' + c.name);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.error('复制连接失败：' + message);
    }
}

async function exportConfigs(): Promise<void> {
    const blob = new Blob([JSON.stringify({ connections: conn.list, selectedId: conn.selectedId }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `mqtt-mountain-config-${Date.now()}.json`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function importConfigs(): void {
    fileInput.value?.click();
}

async function onImportFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (!f) return;
    const previousList = JSON.parse(JSON.stringify(conn.list)) as ConnectionConfig[];
    const previousSelectedId = conn.selectedId;
    const previousDirty = conn.dirty;
    try {
        const text = await f.text();
        const data = JSON.parse(text);
        const arr = Array.isArray(data) ? data : (data && typeof data === 'object' && Array.isArray(data.connections) ? data.connections : []);
        if (!arr.length) throw new Error('文件中没有连接配置');
        const existingIds = new Set(conn.list.map((item) => item.id));
        for (const item of arr) {
            if (!item || typeof item !== 'object') throw new Error('连接配置格式不正确');
            const raw = item as Record<string, unknown>;
            let id = String(raw.id ?? '');
            if (!id || existingIds.has(id)) id = (Date.now() + Math.random()).toString(36);
            existingIds.add(id);
            conn.list.push(normalizeConnectionConfig({
                id,
                name: typeof raw.name === 'string' ? raw.name : '导入连接',
                protocol: raw.protocol as MqttProtocol,
                host: typeof raw.host === 'string' ? raw.host : '',
                port: Number(raw.port),
                path: typeof raw.path === 'string' ? raw.path : '/mqtt',
                username: typeof raw.username === 'string' ? raw.username : '',
                password: typeof raw.password === 'string' ? raw.password : '',
                clientId: randomClientId(),
                subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions as ConnectionConfig['subscriptions'] : [],
                disabledTopics: Array.isArray(raw.disabledTopics) ? raw.disabledTopics as string[] : [],
                createdAt: Number(raw.createdAt) || Date.now(),
                updatedAt: Date.now()
            }));
        }
        conn.sanitizeConnections();
        conn.touch();
        await conn.persist();
        toast.success(`已导入 ${arr.length} 个连接`);
    } catch (err) {
        conn.list.splice(0, conn.list.length, ...previousList);
        conn.selectedId = previousSelectedId;
        conn.touch();
        conn.dirty = previousDirty;
        toast.error('导入失败：' + (err as Error).message);
    } finally {
        input.value = '';
    }
}

watch(
    () => selected.value?.id,
    () => { showPassword.value = false; }
);
</script>

<template>
    <section class="panel">
        <div class="panel-head">
            <h2>📡 连接管理</h2>
            <span class="spacer"></span>
            <button class="btn btn-mini" @click="exportConfigs" title="导出全部">📤</button>
            <button class="btn btn-mini" @click="importConfigs" title="导入">📥</button>
            <input ref="fileInput" type="file" accept=".json" style="display: none" @change="onImportFile" />
            <button class="btn btn-mini btn-success" @click="newConn">➕ 新增</button>
        </div>
        <div class="panel-body">
            <div class="split">
                <div class="list">
                    <div v-if="conn.list.length === 0" class="empty">暂无连接配置</div>
                    <div
                        v-for="c in conn.list"
                        :key="c.id"
                        class="item"
                        :class="{ active: c.id === conn.selectedId }"
                        @click="selectConn(c.id)"
                    >
                        <span class="dot" :class="conn.states[c.id]?.state || 'idle'"></span>
                        <div class="meta">
                            <div class="name">{{ c.name || '未命名' }}</div>
                            <div class="addr">{{ c.protocol }}{{ c.host }}:{{ c.port }}</div>
                        </div>
                        <button class="btn btn-mini btn-ghost" @click.stop="duplicateConn(c.id)" title="复制">📋</button>
                        <button class="btn btn-mini btn-ghost" @click.stop="removeConn(c.id)" title="删除">🗑️</button>
                    </div>
                </div>
                <div v-if="selected" class="form">
                    <div class="field">
                        <label>配置名称</label>
                        <input :value="selected.name" @input="conn.update(selected.id, { name: ($event.target as HTMLInputElement).value })" placeholder="生产环境" />
                    </div>
                    <div class="field">
                        <label>协议</label>
                        <select :value="selected.protocol" @change="onProtocolChange(($event.target as HTMLSelectElement).value as MqttProtocol)">
                            <option value="mqtt://">mqtt:// (TCP)</option>
                            <option value="mqtts://">mqtts:// (TCP Secure)</option>
                            <option value="ws://">ws:// (WebSocket)</option>
                            <option value="wss://">wss:// (WebSocket Secure)</option>
                        </select>
                    </div>
                    <div class="field">
                        <label>服务器地址</label>
                        <input :value="selected.host" @input="conn.update(selected.id, { host: ($event.target as HTMLInputElement).value })" placeholder="broker.emqx.io" />
                    </div>
                    <div class="field">
                        <label>端口</label>
                        <input type="number" :value="selected.port" @input="conn.update(selected.id, { port: Number(($event.target as HTMLInputElement).value) })" />
                    </div>
                    <div v-if="isWs" class="field">
                        <label>路径（WebSocket）</label>
                        <input :value="selected.path" @input="conn.update(selected.id, { path: ($event.target as HTMLInputElement).value })" placeholder="/mqtt" />
                    </div>
                    <div class="field">
                        <label>用户名</label>
                        <input :value="selected.username" @input="conn.update(selected.id, { username: ($event.target as HTMLInputElement).value })" />
                    </div>
                    <div class="field">
                        <label>密码</label>
                        <div class="password">
                            <input :type="showPassword ? 'text' : 'password'" :value="selected.password" @input="conn.update(selected.id, { password: ($event.target as HTMLInputElement).value })" />
                            <button type="button" class="btn btn-mini btn-ghost" @click="showPassword = !showPassword">{{ showPassword ? '🙈' : '👁️' }}</button>
                        </div>
                    </div>
                    <div class="field">
                        <label>Client ID</label>
                        <div class="password">
                            <input :value="selected.clientId" @input="conn.update(selected.id, { clientId: ($event.target as HTMLInputElement).value })" />
                            <button type="button" class="btn btn-mini btn-ghost" @click="conn.update(selected.id, { clientId: randomClientId() })" title="随机生成">🎲</button>
                        </div>
                    </div>
                    <div class="actions">
                        <button class="btn btn-ghost" @click="saveConfig">💾 保存</button>
                        <button v-if="!isConnected" class="btn btn-primary" :disabled="connecting" @click="doConnect">
                            {{ connecting ? '连接中…' : '🔌 连接' }}
                        </button>
                        <button v-else class="btn btn-danger" @click="doDisconnect">断开</button>
                    </div>
                </div>
                <div v-else class="form placeholder">
                    <div class="emoji">🔌</div>
                    <div>请在左侧选择或新增连接</div>
                </div>
            </div>
        </div>
    </section>
</template>

<style lang="scss" scoped>
.split {
    display: grid;
    grid-template-rows: minmax(90px, auto) 1fr;
    gap: 10px;
    min-height: 0;
    flex: 1;
}
.list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow-y: auto;
    max-height: 210px;
    padding-right: 2px;
    background: var(--panel-body-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 4px;
}
.item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 9px;
    border-radius: 8px;
    border: 1px solid transparent;
    background: var(--card-bg);
    cursor: pointer;
    transition: background 0.15s;

    &:hover {
        background: var(--card-hover-bg);
    }
    &.active {
        background: rgba(124, 92, 255, 0.18);
        border-color: rgba(124, 92, 255, 0.4);
    }
    .meta {
        flex: 1;
        min-width: 0;
        .name {
            font-size: 12px;
            font-weight: 600;
            color: var(--text-0);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .addr {
            font-size: 11px;
            color: var(--text-3);
            font-family: 'JetBrains Mono', Consolas, monospace;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            user-select: text;
            cursor: text;
        }
    }
    .btn.btn-ghost {
        opacity: 0.4;
    }
    &:hover .btn.btn-ghost {
        opacity: 1;
    }
}
.form {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: 2px;

    &.placeholder {
        align-items: center;
        justify-content: center;
        color: var(--text-3);
        text-align: center;
        overflow: hidden;
        .emoji {
            font-size: 40px;
            margin-bottom: 8px;
        }
    }
}
.password {
    position: relative;
    display: block;

    input {
        width: 100%;
        padding-right: 36px;
    }

    button {
        position: absolute;
        right: 4px;
        top: 50%;
        transform: translateY(-50%);
        padding: 3px 6px;
        font-size: 13px;
        line-height: 1;
        background: transparent;
        border: none;
        opacity: 0.7;
        transition: opacity 0.12s, background 0.12s;

        &:hover {
            opacity: 1;
            background: var(--card-hover-bg);
            border-radius: 4px;
        }
    }
}
.actions {
    display: flex;
    gap: 6px;
    margin-top: 4px;
    flex-wrap: wrap;
}
</style>
