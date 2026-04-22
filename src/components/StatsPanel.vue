<script setup lang="ts">
import { computed } from 'vue';
import { useMessageStore } from '@/stores/messages';

const msg = useMessageStore();

const topicsCount = computed(() => {
    void msg.topicsVersion;
    return msg.topics.size;
});
const timelineLen = computed(() => {
    void msg.timelineVersion;
    return msg.timeline.length;
});
const timelineCap = computed(() => {
    void msg.timelineVersion;
    return msg.timeline.capacity;
});
</script>

<template>
    <section class="panel">
        <div class="panel-head">
            <h2>📊 统计信息</h2>
        </div>
        <div class="panel-body">
            <div class="grid">
                <div class="card">
                    <div class="val">{{ msg.receiveCount }}</div>
                    <div class="lbl">收到消息</div>
                </div>
                <div class="card">
                    <div class="val">{{ msg.publishCount }}</div>
                    <div class="lbl">发送消息</div>
                </div>
                <div class="card">
                    <div class="val">{{ topicsCount }}</div>
                    <div class="lbl">活跃主题</div>
                </div>
                <div class="card">
                    <div class="val">{{ timelineLen }}<span class="sub">/{{ timelineCap }}</span></div>
                    <div class="lbl">内存消息</div>
                </div>
            </div>
        </div>
    </section>
</template>

<style lang="scss" scoped>
.grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
}
.card {
    background: var(--head-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
    text-align: center;
    .val {
        font-size: 22px;
        font-weight: 700;
        color: var(--accent);
        font-variant-numeric: tabular-nums;
        .sub {
            font-size: 12px;
            color: var(--text-3);
            margin-left: 2px;
        }
    }
    .lbl {
        font-size: 11px;
        color: var(--text-3);
        margin-top: 2px;
    }
}
</style>
