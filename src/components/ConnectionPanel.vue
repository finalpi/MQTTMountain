<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import { useConnectionStore } from '@/stores/connection';
import { useMessageStore } from '@/stores/messages';
import { useToast } from '@/composables/useToast';
import type { MqttProtocol } from '@shared/types';
import { randomClientId } from '@/utils/format';

const conn = useConnectionStore();
const msg = useMessageStore();
const toast = useToast();

const showPassword = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const selected = computed(() => conn.selected);
const isConnected = computed(() => conn.selectedState === 'connected' || conn.selectedState === 'reconnecting');

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

async function doConnect(): Promise<void> {
    const c = selected.value;
    if (!c) return;
    if (!c.host) { toast.error('请填写服务器地址'); return; }
    if (!c.port) { toast.error('请填写端口'); return; }
    await conn.persist();
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
    if (!r.success) {
        toast.error('连接失败：' + (r.message || ''));
        conn.setState(c.id, 'error', r.message);
        return;
    }
    // 连接后恢复订阅（跳过已暂停的）
    for (const sub of c.subscriptions) {
        if (sub.paused) continue;
        await window.api.mqttSubscribe({ connectionId: c.id, topic: sub.topic, qos: sub.qos });
    }
    // 恢复最近消息
    const recent = await window.api.mqttReadRecent({ connectionId: c.id, limit: 2000 });
    if (recent.success && recent.data) msg.hydrate(recent.data);
    toast.success('已连接');
}

async function doDisconnect(): Promise<void> {
    const c = selected.value;
    if (!c) return;
    await window.api.mqttDisconnect(c.id);
    conn.setState(c.id, 'closed');
    toast.info('已断开');
}

function newConn(): void {
    const c = conn.create();
    toast.success('已新增连接：' + c.name);
}

async function selectConn(id: string): Promise<void> {
    conn.select(id);
    msg.clearAll();
    await nextTick();
    const r = await window.api.mqttReadRecent({ connectionId: id, limit: 2000 });
    if (r.success && r.data) msg.hydrate(r.data);
}

function removeConn(id: string): void {
    if (!confirm('确定删除这个连接配置？')) return;
    window.api.mqttDisconnect(id);
    conn.remove(id);
}

function duplicateConn(id: string): void {
    const c = conn.duplicate(id);
    if (c) toast.success('已复制连接：' + c.name);
}

async function exportConfigs(): Promise<void> {
    const blob = new Blob([JSON.stringify({ connections: conn.list, selectedId: conn.selectedId }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mqtt-mountain-config-${Date.now()}.json`;
    a.click();
}

function importConfigs(): void {
    fileInput.value?.click();
}

async function onImportFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (!f) return;
    try {
        const text = await f.text();
        const data = JSON.parse(text);
        const arr = Array.isArray(data) ? data : (data.connections ?? []);
        for (const raw of arr) {
            conn.list.push({
                id: raw.id ?? (Date.now() + Math.random()).toString(36),
                name: raw.name ?? '导入连接',
                protocol: raw.protocol ?? 'mqtt://',
                host: raw.host ?? '',
                port: raw.port ?? 1883,
                path: raw.path ?? '/mqtt',
                username: raw.username ?? '',
                password: raw.password ?? '',
                clientId: raw.clientId ?? randomClientId(),
                subscriptions: raw.subscriptions ?? [],
                disabledTopics: raw.disabledTopics ?? [],
                createdAt: raw.createdAt ?? Date.now(),
                updatedAt: Date.now()
            });
        }
        await conn.persist();
        toast.success(`已导入 ${arr.length} 个连接`);
    } catch (err) {
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
                    <div class="field-row">
                        <div class="field">
                            <label>端口</label>
                            <input type="number" :value="selected.port" @input="conn.update(selected.id, { port: Number(($event.target as HTMLInputElement).value) })" />
                        </div>
                        <div class="field">
                            <label>路径</label>
                            <input :value="selected.path" @input="conn.update(selected.id, { path: ($event.target as HTMLInputElement).value })" placeholder="/mqtt" />
                        </div>
                    </div>
                    <div class="field-row">
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
                    </div>
                    <div class="field">
                        <label>Client ID</label>
                        <div class="password">
                            <input :value="selected.clientId" @input="conn.update(selected.id, { clientId: ($event.target as HTMLInputElement).value })" />
                            <button type="button" class="btn btn-mini btn-ghost" @click="conn.update(selected.id, { clientId: randomClientId() })" title="随机生成">🎲</button>
                        </div>
                    </div>
                    <div class="actions">
                        <button class="btn btn-ghost" @click="conn.persist()">💾 保存</button>
                        <button v-if="!isConnected" class="btn btn-primary" @click="doConnect">🔌 连接</button>
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
    display: flex;
    gap: 4px;
    align-items: center;
    input {
        flex: 1;
    }
    button {
        padding: 6px 8px;
    }
}
.actions {
    display: flex;
    gap: 6px;
    margin-top: 4px;
    flex-wrap: wrap;
}
</style>
