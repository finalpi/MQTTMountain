<script setup lang="ts">
import { ref, computed } from 'vue';
import { useConnectionStore } from '@/stores/connection';
import { useMessageStore } from '@/stores/messages';
import { useToast } from '@/composables/useToast';
import { useUiPrefs } from '@/composables/useUiPrefs';
import { shortTime, prettyJson } from '@/utils/format';

const conn = useConnectionStore();
const msg = useMessageStore();
const toast = useToast();
const { prefs } = useUiPrefs();

const topic = ref('test/message');
const qos = ref<0 | 1 | 2>(0);
const retain = ref(false);
const payload = ref('{"msg": "hello"}');

const canOp = computed(() => conn.selectedState === 'connected');

async function doPublish(): Promise<void> {
    const c = conn.selected;
    if (!c) return;
    if (!canOp.value) { toast.error('请先连接'); return; }
    if (!topic.value.trim()) { toast.error('主题不能为空'); return; }
    const r = await window.api.mqttPublish({
        connectionId: c.id,
        topic: topic.value.trim(),
        payload: payload.value,
        qos: qos.value,
        retain: retain.value
    });
    if (r.success) {
        msg.pushPublishHistory({ topic: topic.value.trim(), payload: payload.value, qos: qos.value, retain: retain.value, time: Date.now() });
        toast.success('已发送');
    } else {
        toast.error('发送失败：' + (r.message || ''));
    }
}

function repeat(item: { topic: string; payload: string; qos: number; retain: boolean }): void {
    topic.value = item.topic;
    payload.value = item.payload;
    qos.value = item.qos as 0 | 1 | 2;
    retain.value = item.retain;
}

function tryFormat(): void {
    payload.value = prettyJson(payload.value);
}

const historyList = computed(() => {
    void msg.publishHistoryVersion;
    return msg.publishHistory.snapshot().reverse();
});
</script>

<template>
    <section class="panel" :class="{ collapsed: !prefs.pubOpen }">
        <div class="panel-head clickable" @click="prefs.pubOpen = !prefs.pubOpen">
            <h2>📤 发布消息</h2>
            <span class="spacer"></span>
            <span class="chev">{{ prefs.pubOpen ? '▾' : '▸' }}</span>
        </div>
        <div v-if="prefs.pubOpen" class="panel-body">
            <div class="field">
                <label>目标主题</label>
                <input v-model="topic" placeholder="test/topic" />
            </div>
            <div class="field-row">
                <div class="field">
                    <label>QoS</label>
                    <select v-model.number="qos">
                        <option :value="0">0</option>
                        <option :value="1">1</option>
                        <option :value="2">2</option>
                    </select>
                </div>
                <div class="field">
                    <label>Retain</label>
                    <select :value="retain ? 'true' : 'false'" @change="retain = ($event.target as HTMLSelectElement).value === 'true'">
                        <option value="false">false</option>
                        <option value="true">true</option>
                    </select>
                </div>
            </div>
            <div class="field">
                <label>消息内容
                    <button class="btn btn-mini btn-ghost" style="float: right" @click="tryFormat">🪄 格式化</button>
                </label>
                <textarea v-model="payload" rows="5"></textarea>
            </div>
            <button class="btn btn-primary" :disabled="!canOp" @click="doPublish">发布</button>

            <div class="history">
                <label>发送历史</label>
                <div v-if="historyList.length === 0" class="empty">暂无发送记录</div>
                <div v-for="(h, idx) in historyList" :key="idx" class="item" @click="repeat(h)" title="点击重放">
                    <span class="time">{{ shortTime(h.time) }}</span>
                    <span class="pill">QoS {{ h.qos }}</span>
                    <span class="t">{{ h.topic }}</span>
                    <span class="p">{{ h.payload }}</span>
                </div>
            </div>
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

.history {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 220px;
    overflow-y: auto;

    > label {
        font-size: 11px;
        color: var(--text-2);
        position: sticky;
        top: 0;
        background: var(--surface);
        padding: 2px 0;
    }

    .item {
        display: flex;
        gap: 8px;
        align-items: center;
        padding: 5px 8px;
        background: var(--card-bg);
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;

        &:hover {
            background: var(--card-hover-bg);
        }

        .time {
            font-family: 'JetBrains Mono', Consolas, monospace;
            color: var(--text-3);
            font-size: 11px;
        }
        .t {
            color: var(--accent-2);
            font-family: 'JetBrains Mono', Consolas, monospace;
        }
        .p {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: var(--text-2);
            font-family: 'JetBrains Mono', Consolas, monospace;
        }
    }
}
</style>
