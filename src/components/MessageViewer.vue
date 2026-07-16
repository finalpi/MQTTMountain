<script setup lang="ts">
import { computed, ref, watch, onUnmounted, watchEffect, nextTick } from 'vue';
import { useMessageStore, type TopicView, type MsgRow } from '@/stores/messages';
import { useConnectionStore } from '@/stores/connection';
import { useToast } from '@/composables/useToast';
import { useFormatViewer } from '@/composables/useFormatViewer';
import { useUiPrefs } from '@/composables/useUiPrefs';
import DynamicVirtualList from '@/components/DynamicVirtualList.vue';
import { highlight, normalize, type SearchLogic } from '@/utils/filter';
import { isTextInputBusy, textInputBusyRemainingMs } from '@/utils/textInputActivity';
import { formatTime, shortTime } from '@/utils/format';
import { exportMqttxJson, exportGroupedZip } from '@/utils/exporter';
import type { HistoryIndexStatus, HistoryKeywordCondition, HistoryMessage, HistoryQueryDone } from '@shared/types';

const msg = useMessageStore();
const conn = useConnectionStore();
const toast = useToast();
const formatViewer = useFormatViewer();
const { prefs } = useUiPrefs();

/** 当前 selected 的连接对应的 bucket（每个连接独立） */
const bucket = computed(() => msg.bucketFor(conn.selectedId));

/** 是否展示消息视图：当前 selected 的连接已 connected（或有历史缓存） */
const hasActiveBucket = computed(() => !!conn.selectedId && msg.hasBucket(conn.selectedId));
const isConnected = computed(() => conn.selectedState === 'connected' || conn.selectedState === 'reconnecting');
const showView = computed(() => isConnected.value || hasActiveBucket.value);

const placeholderTip = computed(() => {
    if (!conn.selectedId) return { emoji: '🔌', title: '还没有选择连接', desc: '请在「📡 连接管理」中选择或新建一个连接' };
    return { emoji: '⚡', title: '该连接未建立', desc: '点击「🔌 连接」查看实时消息，或到「🔍 历史查询」找回已记录数据' };
});

type ViewMode = 'timeline' | 'topic';
const viewMode = ref<ViewMode>('topic');
type FilterJoin = SearchLogic | 'not';
type SelectedTopicHistoryRangeKey = '5m' | '15m' | '1h' | '6h' | '24h' | 'all';
interface FilterCondition {
    term: string;
    join: FilterJoin;
}
interface SelectedTopicHistoryPageResult {
    rows: HistoryMessage[];
    hasMore: boolean;
    timedOut?: boolean;
}
const filterConditions = ref<FilterCondition[]>([{ term: '', join: 'and' }]);
const activeFilterConditions = ref<FilterCondition[]>([{ term: '', join: 'and' }]);
const autoFollow = ref(true);
const showJumpBtn = ref(false);
const DETAIL_HISTORY_LIMIT = 200;
const DETAIL_HISTORY_TIMEOUT_MS = 12_000;
const SELECTED_TOPIC_HISTORY_RANGES: Array<{ key: SelectedTopicHistoryRangeKey; label: string; ms: number | null }> = [
    { key: '5m', label: '近5分钟', ms: 5 * 60 * 1000 },
    { key: '15m', label: '近15分钟', ms: 15 * 60 * 1000 },
    { key: '1h', label: '近1小时', ms: 60 * 60 * 1000 },
    { key: '6h', label: '近6小时', ms: 6 * 60 * 60 * 1000 },
    { key: '24h', label: '近24小时', ms: 24 * 60 * 60 * 1000 },
    { key: 'all', label: '全部历史', ms: null }
];
const selectedTopicHistoryRows = ref<HistoryMessage[]>([]);
const selectedTopicHistoryRange = ref<SelectedTopicHistoryRangeKey>('15m');
const selectedTopicHistoryRangeStartTime = ref<number | undefined>(undefined);
const selectedTopicHistoryRangeEndTime = ref<number | undefined>(undefined);
const selectedTopicHistoryEndTime = ref<number | undefined>(undefined);
const selectedTopicHistoryHasMore = ref(false);
const selectedTopicHistoryLoading = ref(false);
const selectedTopicHistoryLoadedOnce = ref(false);
let selectedTopicHistoryRequestSeq = 0;
let activeSelectedTopicHistoryStreamId: string | null = null;
let selectedTopicHistoryStreamSeq = 0;
const selectedTopicHistoryCache = new Map<string, { rows: HistoryMessage[]; hasMore: boolean }>();
const SELECTED_TOPIC_HISTORY_CACHE_LIMIT = 20;
const selectedTopicHistoryIndexStatus = ref<HistoryIndexStatus | null>(null);
const selectedTopicHistoryIndexStatusConnectionId = ref<string | null>(null);
const selectedTopicHistoryIndexStatusLoading = ref(false);
const GLOBAL_HISTORY_FALLBACK_LIMIT = 500;
const globalHistoryFallbackKeys = new Set<string>();
let globalHistoryFallbackSeq = 0;

let filterTimer: number | null = null;
function scheduleFilterApply(): void {
    if (filterTimer != null) clearTimeout(filterTimer);
    filterTimer = window.setTimeout(() => {
        const busyRemaining = textInputBusyRemainingMs();
        if (busyRemaining > 0) {
            scheduleFilterApply();
            return;
        }
        activeFilterConditions.value = filterConditions.value.map((item) => ({ term: item.term, join: item.join }));
        filterMatchCache.clear();
        highlightCache.clear();
    }, 650);
}
watch(filterConditions, () => {
    scheduleFilterApply();
}, { deep: true });
onUnmounted(() => { if (filterTimer != null) clearTimeout(filterTimer); });

const highlightTerms = computed(() => activeFilterConditions.value.map((item) => item.term));
const normalizedFilterConditions = computed(() => activeFilterConditions.value
    .map((item) => ({ join: item.join, term: normalize(item.term.trim()) }))
    .filter((item) => item.term));
const hasActiveFilter = computed(() => normalizedFilterConditions.value.length > 0);
const activeFilterKey = computed(() => JSON.stringify(activeHistoryConditions()));
const filterMatchCache = new Map<string, { key: string; value: boolean }>();
const highlightCache = new Map<string, { key: string; value: string }>();
const FILTER_MATCH_CACHE_LIMIT = 5000;
const HIGHLIGHT_CACHE_LIMIT = 1000;
let lastFilterCacheEvictionLogAt = 0;

function activeHistoryConditions(): HistoryKeywordCondition[] {
    return activeFilterConditions.value
        .map((item) => ({ term: item.term.trim(), join: item.join }))
        .filter((item) => item.term);
}

function addFilterCondition(): void {
    filterConditions.value.push({ term: '', join: 'and' });
}

function removeFilterCondition(index: number): void {
    if (filterConditions.value.length <= 1) {
        filterConditions.value[0].term = '';
        filterConditions.value[0].join = 'and';
        return;
    }
    filterConditions.value.splice(index, 1);
}

function matchesFilterConditions(src: string): boolean {
    const active = normalizedFilterConditions.value;
    if (active.length === 0) return true;
    const key = activeFilterKey.value;
    const cached = filterMatchCache.get(src);
    if (cached?.key === key) return cached.value;
    const hay = normalize(src);
    let result = hay.includes(active[0].term);
    for (let i = 1; i < active.length; i++) {
        const item = active[i];
        const hit = hay.includes(item.term);
        if (item.join === 'or') result = result || hit;
        else if (item.join === 'not') result = result && !hit;
        else result = result && hit;
    }
    if (filterMatchCache.size >= FILTER_MATCH_CACHE_LIMIT) {
        filterMatchCache.clear();
        const now = Date.now();
        if (now - lastFilterCacheEvictionLogAt >= 60_000) {
            lastFilterCacheEvictionLogAt = now;
            console.info(`[renderer-diagnostics] ${JSON.stringify({
                event: 'filter-match-cache-evicted',
                limit: FILTER_MATCH_CACHE_LIMIT
            })}`);
        }
    }
    filterMatchCache.set(src, { key, value: result });
    return result;
}

function highlightCached(src: string): string {
    const key = activeFilterKey.value;
    const cached = highlightCache.get(src);
    if (cached?.key === key) return cached.value;
    const value = highlight(src, highlightTerms.value);
    if (highlightCache.size > HIGHLIGHT_CACHE_LIMIT) highlightCache.clear();
    highlightCache.set(src, { key, value });
    return value;
}

watch(activeFilterKey, () => {
    filterMatchCache.clear();
    highlightCache.clear();
    selectedTopicHistoryCache.clear();
});

/** 时间线：按新到旧 */
const timelineList = computed<MsgRow[]>(() => {
    const b = bucket.value;
    void b.timelineVersion;
    if (!hasActiveFilter.value) return b.timeline.reverseSnapshot();
    const out: MsgRow[] = [];
    b.timeline.forEachReverse((r) => {
        if (matchesFilterConditions(r.topic + r.payload)) out.push(r);
    });
    return out;
});

type TopicSort = 'manual' | 'insert' | 'recent' | 'name' | 'count';
const topicSort = ref<TopicSort>('manual');

const liveTopicList = computed<TopicView[]>(() => {
    const b = bucket.value;
    void b.topicsVersion;
    const all: TopicView[] = [];
    for (const v of b.topics.values()) {
        if (hasActiveFilter.value) {
            let hit = matchesFilterConditions(v.topic);
            if (!hit) {
                v.buf.forEachReverse((m) => {
                    if (matchesFilterConditions(m.topic + m.payload)) {
                        hit = true;
                        return false;
                    }
                });
            }
            if (!hit) continue;
        }
        all.push(v);
    }
    const orderIndex = new Map<string, number>();
    b.topicOrder.forEach((topic, index) => orderIndex.set(topic, index));
    const pinnedWeight = (item: TopicView): number => item.pinned ? 0 : 1;
    const stableIndex = (item: TopicView): number => orderIndex.get(item.topic) ?? Number.MAX_SAFE_INTEGER;
    switch (topicSort.value) {
        case 'manual':
            all.sort((a, b) => pinnedWeight(a) - pinnedWeight(b) || stableIndex(a) - stableIndex(b));
            break;
        case 'insert':
            all.sort((a, b) => pinnedWeight(a) - pinnedWeight(b) || stableIndex(a) - stableIndex(b));
            break;
        case 'recent': all.sort((a, b) => pinnedWeight(a) - pinnedWeight(b) || b.lastTime - a.lastTime || stableIndex(a) - stableIndex(b)); break;
        case 'name': all.sort((a, b) => pinnedWeight(a) - pinnedWeight(b) || a.topic.localeCompare(b.topic)); break;
        case 'count': all.sort((a, b) => pinnedWeight(a) - pinnedWeight(b) || b.total - a.total || stableIndex(a) - stableIndex(b)); break;
        default: break;
    }
    return all;
});

const frozenTopicOrder = ref<string[]>([]);
const topicList = computed<TopicView[]>(() => {
    const live = liveTopicList.value;
    if (autoFollow.value || frozenTopicOrder.value.length === 0) return live;
    const byTopic = new Map(live.map((item) => [item.topic, item]));
    const out: TopicView[] = [];
    for (const topic of frozenTopicOrder.value) {
        const item = byTopic.get(topic);
        if (!item) continue;
        out.push(item);
        byTopic.delete(topic);
    }
    out.push(...byTopic.values());
    return out;
});

const selectedTopicView = computed<TopicView | null>(() => {
    const b = bucket.value;
    void b.topicsVersion;
    if (!b.selectedTopic) return null;
    return b.topics.get(b.selectedTopic) ?? null;
});

watchEffect(() => {
    const b = bucket.value;
    void b.topicsVersion;
    if (b.selectedTopic) return;
    if (topicList.value.length === 0) return;
    const cid = conn.selectedId;
    if (!cid) return;
    msg.selectTopic(cid, topicList.value[0].topic);
});

function messageDedupeKey(row: Pick<MsgRow, 'topic' | 'time' | 'payload'>): string {
    return JSON.stringify([row.topic, row.time, row.payload]);
}

function messageRenderKey(row: MsgRow): string {
    return `${row.seq}:${row.topic}:${row.time}:${row.payload.length}`;
}

function timelineMessageKey(row: MsgRow): number {
    return row.seq;
}

function realtimeSelectedTopicRows(): MsgRow[] {
    const b = bucket.value;
    void b.topicsVersion;
    const v = selectedTopicView.value;
    if (!v) return [];
    if (!hasActiveFilter.value) return v.buf.reverseSnapshot();
    const out: MsgRow[] = [];
    v.buf.forEachReverse((r) => {
        if (selectedTopicRowMatchesFilter(v.topic, r.payload)) out.push(r);
    });
    return out;
}

const liveSelectedTopicMessages = computed<MsgRow[]>(() => {
    const rows = realtimeSelectedTopicRows();
    const seen = new Set(rows.map(messageDedupeKey));
    selectedTopicHistoryRows.value.forEach((row, index) => {
        const key = messageDedupeKey(row);
        if (seen.has(key)) return;
        seen.add(key);
        rows.push({
            topic: row.topic,
            payload: row.payload,
            time: row.time,
            seq: -index - 1,
            decoded: null
        });
    });
    return rows;
});

const frozenSelectedMessageOrder = ref<string[]>([]);
const selectedTopicMessages = computed<MsgRow[]>(() => {
    const live = liveSelectedTopicMessages.value;
    if (autoFollow.value || frozenSelectedMessageOrder.value.length === 0) return live;
    const byKey = new Map(live.map((item, index) => [messageRenderKey(item), { item, index }]));
    const out: MsgRow[] = [];
    for (const key of frozenSelectedMessageOrder.value) {
        const hit = byKey.get(key);
        if (!hit) continue;
        out.push(hit.item);
        byKey.delete(key);
    }
    const loadedHistory = [...byKey.values()]
        .filter((hit) => hit.item.seq < 0)
        .sort((a, b) => a.index - b.index)
        .map((hit) => hit.item);
    out.push(...loadedHistory);
    return out;
});

const selectedTopicHistoryRangeLabel = computed(() => SELECTED_TOPIC_HISTORY_RANGES.find((item) => item.key === selectedTopicHistoryRange.value)?.label ?? '近15分钟');
const selectedTopicHistoryIndexHint = computed(() => {
    if (!hasActiveFilter.value || selectedTopicHistoryIndexStatusLoading.value) return '';
    const shortKeyword = activeHistoryConditions().some((item) => {
        const length = Array.from(item.term.trim()).length;
        return length > 0 && length < 3;
    });
    if (shortKeyword && (selectedTopicHistoryRange.value === 'all' || selectedTopicHistoryRange.value === '24h')) {
        return '短关键词建议输入至少 3 个字符或缩小时间范围';
    }
    const status = selectedTopicHistoryIndexStatus.value;
    if (!status || status.totalFiles === 0) return '';
    if (status.incompleteFiles > 0 || status.indexedFiles < status.totalFiles) return '关键词历史建议先建立索引';
    return '';
});
const selectedTopicHistoryStatus = computed(() => {
    if (!selectedTopicView.value) return '';
    const rangeLabel = selectedTopicHistoryRangeLabel.value;
    if (selectedTopicHistoryLoading.value) return `${rangeLabel}加载中...`;
    if (selectedTopicHistoryLoadedOnce.value && selectedTopicHistoryHasMore.value) return `${rangeLabel}已加载 ${selectedTopicHistoryRows.value.length} 条`;
    if (selectedTopicHistoryLoadedOnce.value) return `${rangeLabel}历史已加载 ${selectedTopicHistoryRows.value.length} 条`;
    if (selectedTopicHistoryRange.value === 'all') return '全部历史查询可能较慢';
    return `${rangeLabel}可加载历史`;
});

const showSelectedTopicHistoryAction = computed(() => {
    if (!selectedTopicView.value) return false;
    return selectedTopicHistoryLoading.value || !selectedTopicHistoryLoadedOnce.value || selectedTopicHistoryHasMore.value;
});

const selectedTopicHistoryActionText = computed(() => {
    if (selectedTopicHistoryLoading.value) return '加载历史中...';
    if (!selectedTopicHistoryLoadedOnce.value) return '加载历史消息';
    return selectedTopicHistoryHasMore.value ? '加载更多历史' : '没有更多历史';
});

function selectedTopicRowMatchesFilter(topic: string, payload: string): boolean {
    return matchesFilterConditions(topic + payload);
}

function selectedTopicEffectiveHistoryConditions(topic: string): HistoryKeywordCondition[] {
    const active = normalizedFilterConditions.value;
    const raw = activeHistoryConditions();
    if (active.length === 0) return [];

    const topicHay = normalize(topic);
    let prefixResult = topicHay.includes(active[0].term);
    const out: HistoryKeywordCondition[] = [];
    if (!prefixResult) out.push(raw[0]);

    for (let i = 1; i < active.length; i++) {
        const item = active[i];
        const rawItem = raw[i];
        const topicHit = topicHay.includes(item.term);
        if (item.join === 'or') {
            if (prefixResult) return [];
            if (!topicHit) out.push(rawItem);
            prefixResult = prefixResult || topicHit;
        } else if (item.join === 'not') {
            if (topicHit) return [{ term: '__mqttmountain_no_match__', join: 'and' }];
            out.push(rawItem);
        } else {
            if (!topicHit) out.push(rawItem);
            prefixResult = prefixResult && topicHit;
        }
    }
    return out.filter(Boolean);
}

function selectedTopicHistoryRequestKey(): string {
    const topic = bucket.value.selectedTopic;
    return JSON.stringify({
        connectionId: conn.selectedId,
        topic,
        conditions: topic ? selectedTopicEffectiveHistoryConditions(topic) : activeHistoryConditions()
    });
}

function selectedTopicHistoryCacheKey(endTime: number | undefined): string {
    return JSON.stringify({
        key: selectedTopicHistoryRequestKey(),
        range: selectedTopicHistoryRange.value,
        startTime: selectedTopicHistoryRangeStartTime.value,
        endTime,
        limit: DETAIL_HISTORY_LIMIT
    });
}

function cacheSelectedTopicHistoryPage(key: string, value: { rows: HistoryMessage[]; hasMore: boolean }): void {
    selectedTopicHistoryCache.delete(key);
    selectedTopicHistoryCache.set(key, { rows: value.rows.slice(), hasMore: value.hasMore });
    while (selectedTopicHistoryCache.size > SELECTED_TOPIC_HISTORY_CACHE_LIMIT) {
        const first = selectedTopicHistoryCache.keys().next().value;
        if (first == null) break;
        selectedTopicHistoryCache.delete(first);
    }
}

function getCachedSelectedTopicHistoryPage(key: string): SelectedTopicHistoryPageResult | null {
    const cached = selectedTopicHistoryCache.get(key);
    if (!cached) return null;
    selectedTopicHistoryCache.delete(key);
    selectedTopicHistoryCache.set(key, cached);
    return { rows: cached.rows.slice(), hasMore: cached.hasMore };
}

function nextSelectedTopicHistoryStreamId(): string {
    selectedTopicHistoryStreamSeq++;
    return `detail-history-${Date.now()}-${selectedTopicHistoryStreamSeq}`;
}

function resetSelectedTopicHistory(): void {
    selectedTopicHistoryRequestSeq++;
    void cancelActiveSelectedTopicHistoryStream();
    selectedTopicHistoryRows.value = [];
    selectedTopicHistoryRangeStartTime.value = undefined;
    selectedTopicHistoryRangeEndTime.value = undefined;
    selectedTopicHistoryEndTime.value = undefined;
    selectedTopicHistoryHasMore.value = false;
    selectedTopicHistoryLoading.value = false;
    selectedTopicHistoryLoadedOnce.value = false;
}

function selectedTopicHistoryRangeMs(): number | null {
    return SELECTED_TOPIC_HISTORY_RANGES.find((item) => item.key === selectedTopicHistoryRange.value)?.ms ?? 15 * 60 * 1000;
}

function ensureSelectedTopicHistoryRangeBounds(initialEndTime: number | undefined): void {
    if (selectedTopicHistoryRangeEndTime.value != null) return;
    const end = initialEndTime ?? Date.now();
    selectedTopicHistoryRangeEndTime.value = end;
    const rangeMs = selectedTopicHistoryRangeMs();
    selectedTopicHistoryRangeStartTime.value = rangeMs == null ? undefined : Math.max(0, end - rangeMs);
}

function changeSelectedTopicHistoryRange(event: Event): void {
    selectedTopicHistoryRange.value = (event.target as HTMLSelectElement).value as SelectedTopicHistoryRangeKey;
    selectedTopicHistoryCache.clear();
    resetSelectedTopicHistory();
}

function initialSelectedTopicHistoryEndTime(): number | undefined {
    const realtimeRows = realtimeSelectedTopicRows();
    const oldest = realtimeRows.length ? realtimeRows[realtimeRows.length - 1]?.time : undefined;
    return oldest != null ? oldest - 1 : undefined;
}

async function cancelActiveSelectedTopicHistoryStream(): Promise<void> {
    const requestId = activeSelectedTopicHistoryStreamId;
    activeSelectedTopicHistoryStreamId = null;
    if (requestId) await window.api.historyQueryStreamCancel({ requestId });
}

async function loadSelectedTopicHistoryPage(endTime: number | undefined): Promise<SelectedTopicHistoryPageResult | null> {
    const connectionId = conn.selectedId;
    const topic = selectedTopicView.value?.topic;
    if (!connectionId || !topic) return null;
    const startTime = selectedTopicHistoryRangeStartTime.value;
    if (startTime != null && endTime != null && endTime < startTime) return { rows: [], hasMore: false };
    const conditions = selectedTopicEffectiveHistoryConditions(topic);
    const cacheKey = selectedTopicHistoryCacheKey(endTime);
    const cached = getCachedSelectedTopicHistoryPage(cacheKey);
    if (cached) return cached;

    await cancelActiveSelectedTopicHistoryStream();
    const requestId = nextSelectedTopicHistoryStreamId();
    activeSelectedTopicHistoryStreamId = requestId;
    const rows: HistoryMessage[] = [];

    return await new Promise((resolve) => {
        let settled = false;
        let timeoutId: number | null = null;
        const cleanup = () => {
            if (timeoutId != null) window.clearTimeout(timeoutId);
            offChunk();
            offDone();
            offError();
            if (activeSelectedTopicHistoryStreamId === requestId) activeSelectedTopicHistoryStreamId = null;
        };
        const finish = (result: SelectedTopicHistoryPageResult | null) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (result && !result.timedOut) cacheSelectedTopicHistoryPage(cacheKey, result);
            resolve(result);
        };
        const offChunk = window.api.onHistoryQueryChunk((chunk) => {
            if (chunk.requestId !== requestId) return;
            rows.push(...chunk.rows);
        });
        const offDone = window.api.onHistoryQueryDone((done: HistoryQueryDone) => {
            if (done.requestId !== requestId) return;
            finish({ rows: rows.slice(0, DETAIL_HISTORY_LIMIT), hasMore: rows.length > DETAIL_HISTORY_LIMIT });
        });
        const offError = window.api.onHistoryQueryError((error) => {
            if (error.requestId !== requestId) return;
            toast.error('加载历史失败：' + error.message);
            finish(null);
        });
        timeoutId = window.setTimeout(() => {
            void window.api.historyQueryStreamCancel({ requestId });
            finish({ rows: rows.slice(0, DETAIL_HISTORY_LIMIT), hasMore: true, timedOut: true });
        }, DETAIL_HISTORY_TIMEOUT_MS);

        window.api.historyQueryStreamStart({
            requestId,
            opts: {
                connectionId,
                topic,
                conditions,
                startTime,
                endTime,
                order: 'desc',
                limit: DETAIL_HISTORY_LIMIT + 1,
                offset: 0
            },
            chunkSize: DETAIL_HISTORY_LIMIT + 1
        }).then((r) => {
            if (!r.success) {
                toast.error('加载历史失败：' + (r.message || ''));
                finish(null);
            }
        }).catch((error) => {
            toast.error('加载历史失败：' + ((error as Error).message || ''));
            finish(null);
        });
    });
}

async function refreshSelectedTopicHistoryIndexStatus(): Promise<void> {
    const connectionId = conn.selectedId;
    if (!connectionId || selectedTopicHistoryIndexStatusLoading.value) return;
    if (selectedTopicHistoryIndexStatusConnectionId.value === connectionId && selectedTopicHistoryIndexStatus.value) return;
    selectedTopicHistoryIndexStatusLoading.value = true;
    try {
        const r = await window.api.historyIndexStatus({ connectionId });
        if (r.success && r.data && conn.selectedId === connectionId) {
            selectedTopicHistoryIndexStatus.value = r.data;
            selectedTopicHistoryIndexStatusConnectionId.value = connectionId;
        }
    } finally {
        selectedTopicHistoryIndexStatusLoading.value = false;
    }
}

async function loadMoreSelectedTopicHistory(): Promise<void> {
    if (selectedTopicHistoryLoading.value) return;
    if (selectedTopicHistoryLoadedOnce.value && !selectedTopicHistoryHasMore.value) return;
    if (!conn.selectedId || !selectedTopicView.value) return;
    void refreshSelectedTopicHistoryIndexStatus();
    const requestKey = selectedTopicHistoryRequestKey();
    const requestSeq = ++selectedTopicHistoryRequestSeq;
    const initialEndTime = initialSelectedTopicHistoryEndTime();
    ensureSelectedTopicHistoryRangeBounds(initialEndTime);
    const endTime = selectedTopicHistoryLoadedOnce.value
        ? selectedTopicHistoryEndTime.value
        : selectedTopicHistoryRangeEndTime.value;
    console.info('[message-viewer] history page request', {
        connectionId: conn.selectedId,
        topic: selectedTopicView.value.topic,
        endTime,
        range: selectedTopicHistoryRange.value,
        conditions: activeHistoryConditions().length
    });
    selectedTopicHistoryLoading.value = true;
    let continueAtEnd = false;
    try {
        const result = await loadSelectedTopicHistoryPage(endTime);
        if (requestSeq !== selectedTopicHistoryRequestSeq || requestKey !== selectedTopicHistoryRequestKey()) return;
        if (!result) {
            await cancelActiveSelectedTopicHistoryStream();
            selectedTopicHistoryHasMore.value = true;
            toast.warning('加载历史失败，可稍后再试');
            return;
        }
        const nextEndTime = result.rows.length ? Math.min(...result.rows.map((row) => row.time)) - 1 : endTime;
        const startTime = selectedTopicHistoryRangeStartTime.value;
        selectedTopicHistoryHasMore.value = result.hasMore && !(startTime != null && nextEndTime != null && nextEndTime < startTime);
        selectedTopicHistoryRows.value.push(...result.rows);
        selectedTopicHistoryEndTime.value = nextEndTime;
        selectedTopicHistoryLoadedOnce.value = true;
        continueAtEnd = !result.timedOut && result.rows.length > 0 && selectedTopicHistoryHasMore.value;
        console.info('[message-viewer] history page complete', {
            connectionId: conn.selectedId,
            topic: selectedTopicView.value?.topic,
            rows: result.rows.length,
            hasMore: selectedTopicHistoryHasMore.value,
            nextEndTime,
            timedOut: Boolean(result.timedOut)
        });
        if (result.timedOut) {
            if (result.rows.length > 0) {
                toast.info(`已先加载 ${result.rows.length} 条历史结果，${selectedTopicHistoryRangeLabel.value}查询仍在继续可稍后重试`);
            } else if (selectedTopicHistoryRange.value === 'all') {
                toast.warning('正在查询全部历史，建议先切到近15分钟或近1小时');
            } else {
                toast.warning(`${selectedTopicHistoryRangeLabel.value}历史查询仍较慢，可能是索引未完成或关键词过短，可建立索引后重试`);
            }
        }
    } finally {
        if (requestSeq === selectedTopicHistoryRequestSeq) selectedTopicHistoryLoading.value = false;
    }
    if (continueAtEnd && requestSeq === selectedTopicHistoryRequestSeq) {
        await nextTick();
        // 条件结果较稀疏或本页大多与实时缓存重复时，列表可能仍贴着底部；自动续一页。
        if (viewMode.value === 'topic' && currentVirtual()?.isNearEnd(160)) {
            void loadMoreSelectedTopicHistory();
        }
    }
}

async function backfillGlobalHistoryWhenRealtimeEmpty(): Promise<void> {
    const requestSeq = ++globalHistoryFallbackSeq;
    const connectionId = conn.selectedId;
    const conditions = activeHistoryConditions();
    if (!connectionId || conditions.length === 0 || timelineList.value.length > 0) return;
    const endTime = Date.now();
    const rangeMs = selectedTopicHistoryRangeMs();
    const startTime = rangeMs == null ? undefined : Math.max(0, endTime - rangeMs);
    const key = JSON.stringify({ connectionId, conditions, range: selectedTopicHistoryRange.value });
    if (globalHistoryFallbackKeys.has(key)) return;
    globalHistoryFallbackKeys.add(key);
    while (globalHistoryFallbackKeys.size > 20) {
        const oldest = globalHistoryFallbackKeys.values().next().value;
        if (oldest == null) break;
        globalHistoryFallbackKeys.delete(oldest);
    }
    console.info('[message-viewer] global history fallback request', {
        connectionId,
        range: selectedTopicHistoryRange.value,
        conditions: conditions.length
    });
    const result = await window.api.historyQuery({
        connectionId,
        conditions,
        startTime,
        endTime,
        order: 'desc',
        limit: GLOBAL_HISTORY_FALLBACK_LIMIT
    });
    if (requestSeq !== globalHistoryFallbackSeq || connectionId !== conn.selectedId) return;
    if (!result.success || !result.data) {
        globalHistoryFallbackKeys.delete(key);
        console.warn('[message-viewer] global history fallback failed', {
            connectionId,
            reason: result.message || 'unknown'
        });
        return;
    }
    if (result.data.length === 0) globalHistoryFallbackKeys.delete(key);
    const existing = new Set(bucket.value.timeline.snapshot().map(messageDedupeKey));
    const rows = result.data.filter((row) => !existing.has(messageDedupeKey(row)));
    if (rows.length > 0) {
        await msg.hydrate(connectionId, rows);
        await nextTick();
        const currentTopic = bucket.value.selectedTopic;
        if (!currentTopic || !liveTopicList.value.some((item) => item.topic === currentTopic)) {
            const first = liveTopicList.value[0];
            if (first) msg.selectTopic(connectionId, first.topic);
        }
    }
    console.info('[message-viewer] global history fallback complete', {
        connectionId,
        queriedRows: result.data.length,
        addedRows: rows.length,
        topics: new Set(rows.map((row) => row.topic)).size
    });
}

function setMode(m: ViewMode): void { viewMode.value = m; }

function togglePause(): void {
    const cid = conn.selectedId;
    if (!cid) return;
    msg.setPaused(cid, !bucket.value.paused);
}

function clearAll(): void {
    const cid = conn.selectedId;
    if (!cid) return;
    if (!confirm('清空当前连接当前显示的 MQTT 消息？本地历史日志不会删除。')) return;
    msg.clearAll(cid);
    resetSelectedTopicHistory();
    toast.success('已清屏');
}

async function clearLocalLogs(): Promise<void> {
    const cid = conn.selectedId;
    if (!cid) return;
    if (!confirm('删除当前连接的本地历史日志？当前显示也会清空，删除后无法从历史查询找回。')) return;
    msg.clearAll(cid);
    resetSelectedTopicHistory();
    await window.api.mqttClearLogs(cid);
    toast.success('已删除本地历史日志');
}

async function exportJson(): Promise<void> {
    const rows = bucket.value.timeline.snapshot();
    if (rows.length === 0) { toast.warning('没有消息可导出'); return; }
    exportMqttxJson(rows, `messages-${Date.now()}.json`);
    toast.success(`已导出 ${rows.length} 条`);
}
async function exportZip(): Promise<void> {
    const rows = bucket.value.timeline.snapshot();
    if (rows.length === 0) { toast.warning('没有消息可导出'); return; }
    await exportGroupedZip(rows, `messages-grouped-${Date.now()}.zip`);
    toast.success(`已导出 ${rows.length} 条（按主题分组）`);
}

function selectTopic(t: string): void {
    const cid = conn.selectedId;
    if (!cid) return;
    msg.selectTopic(cid, t);
}
function clearTopic(t: string): void {
    const cid = conn.selectedId;
    if (!cid) return;
    msg.clearTopic(cid, t);
    if (bucket.value.selectedTopic === t) resetSelectedTopicHistory();
}
function deleteTopic(t: string): void {
    const cid = conn.selectedId;
    if (!cid) return;
    if (!confirm(`删除主题「${t}」及其消息？`)) return;
    const wasSelected = bucket.value.selectedTopic === t;
    msg.removeTopic(cid, t);
    if (wasSelected) resetSelectedTopicHistory();
}
async function toggleDisable(v: TopicView): Promise<void> {
    const cid = conn.selectedId;
    if (!cid) return;
    const next = !v.disabled;
    msg.setTopicDisabled(cid, v.topic, next);
    conn.toggleDisableTopic(cid, v.topic, next);
    if (next) await window.api.mqttDisableTopic({ connectionId: cid, topic: v.topic });
    else await window.api.mqttEnableTopic({ connectionId: cid, topic: v.topic });
}
function togglePinTop(topic: string): void {
    const cid = conn.selectedId;
    if (!cid) return;
    const target = bucket.value.topics.get(topic);
    if (!target) return;
    msg.setTopicPinned(cid, topic, !target.pinned);
}

// 滚动容器引用与「跟随新消息」
interface DynamicListHandle {
    getScrollElement: () => HTMLElement | null;
    scrollToTop: (smooth?: boolean) => void;
    resetMeasurements: (scrollTopAfterReset?: boolean) => void;
    isNearEnd: (threshold?: number) => boolean;
}

const timelineVirtualRef = ref<DynamicListHandle | null>(null);
const topicVirtualRef = ref<DynamicListHandle | null>(null);
let pausedFollowHasLeftStart = false;
let returningToStart = false;

const timelineResetKey = computed(() => JSON.stringify({ connectionId: conn.selectedId, filter: activeFilterKey.value }));
const topicListResetKey = computed(() => JSON.stringify({ connectionId: conn.selectedId, filter: activeFilterKey.value, sort: topicSort.value }));
const topicResetKey = computed(() => JSON.stringify({ connectionId: conn.selectedId, topic: bucket.value.selectedTopic, filter: activeFilterKey.value }));
const messageLayoutKey = computed(() => `${prefs.fontSize}:${viewMode.value}`);

function currentVirtual(): DynamicListHandle | null {
    return viewMode.value === 'timeline' ? timelineVirtualRef.value : topicVirtualRef.value;
}

function currentScroll(): HTMLElement | null {
    return currentVirtual()?.getScrollElement() ?? null;
}

function estimateMessageSize(row: MsgRow, includeTopic: boolean): number {
    const font = prefs.fontSize;
    const payloadCharsPerLine = 110;
    const topicCharsPerLine = 80;
    const payloadLines = Math.max(1, row.payload.split('\n').reduce((sum, part) => sum + Math.max(1, Math.ceil(part.length / payloadCharsPerLine)), 0));
    const topicLines = includeTopic ? Math.max(1, Math.ceil(row.topic.length / topicCharsPerLine)) : 0;
    return 28 + topicLines * Math.max(14, font * 1.4) + payloadLines * Math.max(16, font * 1.5);
}

function estimateTimelineMessageSize(row: MsgRow): number {
    return estimateMessageSize(row, true);
}

function estimateTopicMessageSize(row: MsgRow): number {
    return estimateMessageSize(row, false);
}

function topicViewKey(row: TopicView): string {
    return row.topic;
}

function estimateTopicListItemSize(row: TopicView): number {
    const topicCharsPerLine = 32;
    const topicLines = Math.max(1, Math.ceil(row.topic.length / topicCharsPerLine));
    return 34 + topicLines * Math.max(15, prefs.fontSize * 1.45);
}

function freezeTopicOrder(): void {
    frozenTopicOrder.value = liveTopicList.value.map((item) => item.topic);
}

function freezeSelectedMessageOrder(): void {
    frozenSelectedMessageOrder.value = liveSelectedTopicMessages.value.map(messageRenderKey);
}

function freezeVisibleOrder(): void {
    freezeTopicOrder();
    freezeSelectedMessageOrder();
}

function unfreezeTopicOrder(): void {
    frozenTopicOrder.value = [];
}

function unfreezeSelectedMessageOrder(): void {
    frozenSelectedMessageOrder.value = [];
}

function unfreezeVisibleOrder(): void {
    unfreezeTopicOrder();
    unfreezeSelectedMessageOrder();
}

function onUserScrollIntent(): void {
    if (autoFollow.value) {
        freezeVisibleOrder();
        autoFollow.value = false;
        pausedFollowHasLeftStart = false;
        showJumpBtn.value = true;
    }
    // 已经位于底部时继续滚轮不会产生 scroll 事件，必须从用户交互入口继续加载。
    if (viewMode.value === 'topic' && currentVirtual()?.isNearEnd(160)) {
        void loadMoreSelectedTopicHistory();
    }
}

function onUserScroll(): void {
    const el = currentScroll();
    if (!el) return;
    if (returningToStart) {
        showJumpBtn.value = false;
        if (el.scrollTop <= 4) returningToStart = false;
        return;
    }
    // 用户离开顶部 → 关闭跟随；回到顶部附近 → 恢复跟随
    if (el.scrollTop > 60) {
        pausedFollowHasLeftStart = true;
        if (autoFollow.value) {
            freezeVisibleOrder();
            autoFollow.value = false;
        }
        showJumpBtn.value = true;
    } else if (el.scrollTop <= 4 && pausedFollowHasLeftStart) {
        showJumpBtn.value = false;
        if (!autoFollow.value) {
            autoFollow.value = true;
            unfreezeVisibleOrder();
        }
        pausedFollowHasLeftStart = false;
    } else if (!autoFollow.value) {
        // 用户刚从顶部开始向下滚时保留暂停状态，避免 60px 内被自动跟随拉回顶部。
        showJumpBtn.value = true;
    }
    if (viewMode.value === 'topic' && el.scrollTop + el.clientHeight >= el.scrollHeight - 160) {
        void loadMoreSelectedTopicHistory();
    }
}

function scrollToTop(smooth = false): void {
    console.info('[message-viewer] return to latest', {
        viewMode: viewMode.value,
        connectionId: conn.selectedId,
        topic: bucket.value.selectedTopic,
        previousScrollTop: currentScroll()?.scrollTop ?? null
    });
    returningToStart = true;
    autoFollow.value = true;
    showJumpBtn.value = false;
    pausedFollowHasLeftStart = false;
    unfreezeVisibleOrder();
    const apply = (useSmooth: boolean) => currentVirtual()?.scrollToTop(useSmooth);
    apply(smooth);
    void nextTick(() => {
        // 解除冻结会触发一次虚拟列表布局重算，布局稳定后再次校准，避免旧锚点覆盖跳顶。
        apply(false);
        requestAnimationFrame(() => {
            apply(false);
            returningToStart = false;
        });
    });
}

watch(
    () => [conn.selectedId, bucket.value.selectedTopic, activeFilterKey.value, selectedTopicHistoryRange.value] as const,
    async () => {
        if (conn.selectedId == null || bucket.value.selectedTopic == null) selectedTopicHistoryCache.clear();
        if (selectedTopicHistoryIndexStatusConnectionId.value !== conn.selectedId) {
            selectedTopicHistoryIndexStatus.value = null;
            selectedTopicHistoryIndexStatusConnectionId.value = conn.selectedId;
        }
        resetSelectedTopicHistory();
        await nextTick();
        topicVirtualRef.value?.resetMeasurements(true);
        void backfillGlobalHistoryWhenRealtimeEmpty();
    }
);

// 当消息更新时，若仍处于「跟随」模式则保持在顶部
watch(
    () => [bucket.value.timelineVersion, bucket.value.topicsVersion, bucket.value.selectedTopic, viewMode.value, conn.selectedId] as const,
    async () => {
        if (!autoFollow.value || isTextInputBusy()) return;
        await nextTick();
        if (isTextInputBusy()) return;
        currentVirtual()?.scrollToTop(false);
    }
);

const contextMenu = ref<{ visible: boolean; x: number; y: number; topic: string | null }>({ visible: false, x: 0, y: 0, topic: null });
function openContext(e: MouseEvent, topic: string): void {
    contextMenu.value = { visible: true, x: e.clientX, y: e.clientY, topic };
}
function closeContext(): void {
    contextMenu.value.visible = false;
}
window.addEventListener('click', closeContext);
onUnmounted(() => {
    window.removeEventListener('click', closeContext);
    void cancelActiveSelectedTopicHistoryStream();
});
</script>

<template>
    <section class="panel messages">
        <div class="panel-head">
            <div class="mode-toggle">
                <button class="tgl" :class="{ active: viewMode === 'timeline' }" @click="setMode('timeline')">⏱️ 时间线</button>
                <button class="tgl" :class="{ active: viewMode === 'topic' }" @click="setMode('topic')">📑 主题分组</button>
            </div>
            <span class="spacer"></span>
            <button
                class="btn btn-mini"
                :class="bucket.paused ? 'btn-warning' : ''"
                @click="togglePause"
                :title="bucket.paused ? '恢复显示（数据库并未停止记录）' : '暂停显示新消息（主进程仍正常记录到数据库）'"
            >{{ bucket.paused ? '▶️ 恢复' : '⏸️ 暂停' }}</button>
            <button class="btn btn-mini" @click="exportJson" title="导出完整 JSON">📥</button>
            <button class="btn btn-mini" @click="exportZip" title="按主题分组 ZIP">📦</button>
            <button class="btn btn-mini" @click="clearAll" title="清屏当前连接显示，不删除历史日志">清屏</button>
            <button class="btn btn-mini btn-danger" @click="clearLocalLogs" title="删除当前连接本地历史日志">删日志</button>
        </div>
        <div class="panel-body">
            <div v-if="!showView" class="mismatch">
                <div class="emoji">{{ placeholderTip.emoji }}</div>
                <div class="title">{{ placeholderTip.title }}</div>
                <div class="desc">{{ placeholderTip.desc }}</div>
            </div>

            <template v-else>
            <div class="filter-row">
                <div class="filter-builder">
                    <div class="logic-anchor">过滤</div>
                    <div class="filter-conditions">
                        <div v-for="(item, index) in filterConditions" :key="index" class="filter-condition">
                            <span v-if="index === 0" class="condition-index">条件 1</span>
                            <div v-else class="logic-segment" role="tablist" :aria-label="`条件 ${index + 1} 逻辑`">
                                <button class="seg-btn" :class="{ active: item.join === 'and' }" @click="item.join = 'and'">且</button>
                                <button class="seg-btn" :class="{ active: item.join === 'or' }" @click="item.join = 'or'">或</button>
                                <button class="seg-btn" :class="{ active: item.join === 'not' }" @click="item.join = 'not'">非</button>
                            </div>
                            <input v-model="item.term" placeholder="过滤主题或内容" class="filter-input" />
                            <button class="condition-btn" title="删除条件" @click="removeFilterCondition(index)">×</button>
                        </div>
                    </div>
                    <button class="condition-add" title="添加过滤条件" @click="addFilterCondition">+ 条件</button>
                </div>
                <button
                    class="follow-btn"
                    :class="{ active: autoFollow }"
                    :title="autoFollow ? '新消息自动滚动到顶部（点击暂停）' : '恢复跟随新消息'"
                    @click="autoFollow ? (freezeVisibleOrder(), autoFollow = false, showJumpBtn = true) : scrollToTop(false)"
                >📌 {{ autoFollow ? '跟随中' : '已暂停' }}</button>
            </div>

            <DynamicVirtualList
                v-if="viewMode === 'timeline'"
                ref="timelineVirtualRef"
                class="scroll-area bordered"
                :items="timelineList"
                :item-key="timelineMessageKey"
                :estimate-size="estimateTimelineMessageSize"
                :stick-to-start="autoFollow"
                :reset-key="timelineResetKey"
                :layout-key="messageLayoutKey"
                empty="暂无消息"
                @scroll="onUserScroll"
                @user-interaction="onUserScrollIntent"
            >
                <template #default="{ item: m }">
                    <div
                        class="msg-card"
                        @contextmenu.prevent="formatViewer.open({ topic: m.topic, time: m.time, raw: m.payload })"
                    >
                        <div class="msg-head">
                            <span class="time">{{ formatTime(m.time) }}</span>
                            <span class="topic" v-html="highlightCached(m.topic)"></span>
                            <span class="msg-hint">右键格式化</span>
                        </div>
                        <pre class="msg-body" v-html="highlightCached(m.payload)"></pre>
                    </div>
                </template>
            </DynamicVirtualList>

            <div v-else class="split">
                <div class="topic-list">
                    <div class="t-head">
                        <span>主题（{{ topicList.length }}）</span>
                        <select class="sort-select" v-model="topicSort" title="排序方式">
                            <option value="manual">自定义</option>
                            <option value="name">主题名</option>
                            <option value="insert">首次出现</option>
                            <option value="recent">最近活跃</option>
                            <option value="count">消息量</option>
                        </select>
                    </div>
                    <DynamicVirtualList
                        class="scroll-area topic-virtual-list"
                        :items="topicList"
                        :item-key="topicViewKey"
                        :estimate-size="estimateTopicListItemSize"
                        :reset-key="topicListResetKey"
                        :layout-key="messageLayoutKey"
                        empty="暂无消息"
                    >
                        <template #default="{ item: t }">
                            <div
                                class="t-item"
                                :class="{ active: bucket.selectedTopic === t.topic, disabled: t.disabled, pinned: t.pinned }"
                                @click="selectTopic(t.topic)"
                                @contextmenu.prevent="openContext($event, t.topic)"
                            >
                                <div class="t-row">
                                    <div class="t-name" v-html="highlightCached(t.topic)"></div>
                                    <span v-if="t.pinned" class="pin-badge" title="已置顶">置顶</span>
                                </div>
                                <div class="t-meta">
                                    <span class="count">{{ t.total }} 条</span>
                                    <span class="ago">{{ shortTime(t.lastTime) }}</span>
                                </div>
                            </div>
                        </template>
                    </DynamicVirtualList>
                </div>
                <div class="topic-detail">
                    <div class="t-head">
                        <span v-if="selectedTopicView" class="t-head-name" :title="selectedTopicView.topic">{{ selectedTopicView.topic }}</span>
                        <span v-else class="empty">请从左侧选择主题</span>
                        <div v-if="selectedTopicView" class="history-tools">
                            <select class="sort-select history-range-select" :value="selectedTopicHistoryRange" title="历史加载范围" @change="changeSelectedTopicHistoryRange">
                                <option v-for="item in SELECTED_TOPIC_HISTORY_RANGES" :key="item.key" :value="item.key">{{ item.label }}</option>
                            </select>
                            <span class="history-status">{{ selectedTopicMessages.length }} 条 · {{ selectedTopicHistoryStatus }}</span>
                        </div>
                    </div>
                    <DynamicVirtualList
                        v-if="selectedTopicView"
                        ref="topicVirtualRef"
                        class="scroll-area"
                        :items="selectedTopicMessages"
                        :item-key="messageRenderKey"
                        :estimate-size="estimateTopicMessageSize"
                        :stick-to-start="autoFollow"
                        :reset-key="topicResetKey"
                        :layout-key="messageLayoutKey"
                        empty="该主题暂无消息"
                        @scroll="onUserScroll"
                        @user-interaction="onUserScrollIntent"
                    >
                        <template #default="{ item: m }">
                            <div
                                class="msg-card"
                                @contextmenu.prevent="formatViewer.open({ topic: m.topic, time: m.time, raw: m.payload })"
                            >
                                <div class="msg-head">
                                    <span class="time">{{ formatTime(m.time) }}</span>
                                    <span class="msg-hint">右键格式化</span>
                                </div>
                                <pre class="msg-body" v-html="highlightCached(m.payload)"></pre>
                            </div>
                        </template>
                        <template #after>
                            <div v-if="showSelectedTopicHistoryAction" class="history-footer">
                                <span v-if="selectedTopicHistoryIndexHint" class="history-index-hint">{{ selectedTopicHistoryIndexHint }}，可到「历史查询」建立/重建索引</span>
                                <button class="history-load-btn" :disabled="selectedTopicHistoryLoading" @click="loadMoreSelectedTopicHistory">
                                    {{ selectedTopicHistoryActionText }}
                                </button>
                            </div>
                        </template>
                    </DynamicVirtualList>
                </div>
            </div>

            <button v-show="showJumpBtn && !bucket.paused" class="jump-top" @click="scrollToTop(false)" title="回到顶部查看最新">
                <span>↑ 新消息</span>
            </button>

            <div v-if="bucket.paused" class="paused-banner" title="点击顶部「▶️ 恢复」继续显示新消息">
                <span>⏸️ 已暂停显示新消息 · 主进程仍在记录到数据库</span>
            </div>

            <div v-if="contextMenu.visible" class="ctx" :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }" @click.stop>
                <button @click="togglePinTop(contextMenu.topic!); closeContext()">
                    {{ bucket.topics.get(contextMenu.topic!)?.pinned ? '取消置顶' : '置顶主题' }}
                </button>
                <button @click="clearTopic(contextMenu.topic!); closeContext()">清空该主题消息</button>
                <button @click="toggleDisable(bucket.topics.get(contextMenu.topic!)!); closeContext()">
                    {{ bucket.topics.get(contextMenu.topic!)?.disabled ? '恢复记录' : '禁用记录' }}
                </button>
                <button @click="deleteTopic(contextMenu.topic!); closeContext()">删除主题</button>
            </div>
            </template>
        </div>
    </section>
</template>

<style lang="scss" scoped>
.messages {
    min-height: 0;
}
.panel-body {
    min-height: 0;
    position: relative;
}

.mismatch {
    flex: 1;
    min-height: 0;
    display: grid;
    place-items: center;
    padding: 40px 24px;
    text-align: center;
    color: var(--text-2);

    .emoji {
        font-size: 56px;
        margin-bottom: 14px;
        opacity: 0.8;
    }
    .title {
        font-size: 16px;
        font-weight: 600;
        color: var(--text-0);
        margin-bottom: 8px;
    }
    .desc {
        font-size: 12px;
        color: var(--text-2);
        line-height: 1.6;
        max-width: 440px;
    }
}
.mode-toggle {
    display: inline-flex;
    padding: 2px;
    background: var(--input-bg);
    border-radius: 8px;
    border: 1px solid var(--border);

    .tgl {
        background: transparent;
        border: none;
        color: var(--text-2);
        font-size: 12px;
        padding: 5px 10px;
        border-radius: 6px;
        cursor: pointer;
        font-family: inherit;
        transition: background 0.15s, color 0.15s;

        &:hover {
            color: var(--text-0);
        }
        &.active {
            background: rgba(124, 92, 255, 0.28);
            color: #fff;
        }
    }
}
.filter-row {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    flex: 0 0 auto;
}

.filter-builder {
    flex: 1;
    min-width: 0;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
}

.logic-anchor {
    height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 58px;
    padding: 0 10px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 700;
}

.filter-conditions {
    flex: 1;
    min-width: 0;
    display: flex;
    gap: 6px;
    align-items: stretch;
    flex-wrap: wrap;
}

.filter-condition {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 6px;
    min-width: 240px;
    max-width: 360px;
    flex: 1 1 280px;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.02);
}

.condition-index {
    color: var(--text-3);
    font-size: 11px;
    font-weight: 700;
    white-space: nowrap;
    padding: 0 8px;
}

.logic-segment {
    display: inline-flex;
    align-items: center;
    padding: 2px;
    height: 34px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
}

.seg-btn {
    min-width: 34px;
    height: 28px;
    padding: 0 8px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
    line-height: 28px;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;

    &:hover {
        color: var(--text-0);
    }

    &.active {
        background: rgba(124, 92, 255, 0.28);
        color: #fff;
    }
}

.filter-input {
    flex: 1;
    min-width: 0;
    height: 34px;
    padding: 0 12px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-0);
    font-size: 13px;
    outline: none;
    &:focus {
        border-color: var(--accent);
    }
}

.condition-btn,
.condition-add {
    height: 34px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--input-bg);
    color: var(--text-2);
    font-family: inherit;
    cursor: pointer;
    white-space: nowrap;

    &:hover {
        color: var(--text-0);
        border-color: var(--border-strong);
    }
}

.condition-btn {
    width: 30px;
}

.condition-add {
    padding: 0 10px;
}

@media (max-width: 900px) {
    .filter-builder {
        grid-template-columns: 1fr;
        align-items: stretch;
    }
}

.follow-btn {
    padding: 0 12px;
    height: 34px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    color: var(--text-2);
    border-radius: 8px;
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
    white-space: nowrap;

    &:hover {
        background: var(--card-hover-bg);
        color: var(--text-0);
    }
    &.active {
        background: rgba(124, 92, 255, 0.25);
        border-color: rgba(124, 92, 255, 0.5);
        color: #fff;
    }
}

.paused-banner {
    position: absolute;
    left: 50%;
    top: 70px;
    transform: translateX(-50%);
    padding: 6px 14px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    background: rgba(245, 158, 11, 0.18);
    border: 1px solid rgba(245, 158, 11, 0.45);
    color: #fbbf24;
    box-shadow: 0 8px 20px -6px rgba(245, 158, 11, 0.35);
    z-index: 5;
    pointer-events: none;
    white-space: nowrap;
}

.jump-top {
    position: absolute;
    right: 18px;
    bottom: 16px;
    padding: 8px 14px;
    border-radius: 999px;
    border: none;
    background: linear-gradient(135deg, #7c5cff, #5b8def);
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 8px 20px -4px rgba(124, 92, 255, 0.5);
    transition: transform 0.15s, filter 0.15s;
    z-index: 5;

    &:hover {
        filter: brightness(1.1);
        transform: translateY(-1px);
    }
}

.split {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(240px, 0.42fr) 1fr;
    gap: 12px;
}

.topic-list,
.topic-detail {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--panel-body-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
}
.t-head {
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-2);
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;

    .t-head-name {
        flex: 1;
        min-width: 0;
        color: var(--accent-2);
        font-family: 'JetBrains Mono', Consolas, monospace;
        user-select: text;
        cursor: text;
        word-break: break-all;
        line-height: 1.4;
    }
    .history-tools {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
    }
    .history-range-select {
        max-width: 96px;
        height: 24px;
        padding: 1px 5px;
    }
    .history-status {
        color: var(--text-3);
        font-size: 11px;
        font-weight: 500;
        white-space: nowrap;
    }
}
.sort-select {
    background: var(--input-bg);
    border: 1px solid var(--border);
    color: var(--text-1);
    border-radius: 6px;
    padding: 2px 6px;
    font-size: 11px;
    font-family: inherit;
    outline: none;
    cursor: pointer;
    &:focus {
        border-color: var(--accent);
    }
}
.topic-virtual-list {
    background: transparent;
}

.t-item {
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: rgba(255, 255, 255, 0.02);
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;

    &:hover {
        background: rgba(255, 255, 255, 0.06);
        border-color: var(--border-strong);
    }
    &.active {
        background: rgba(124, 92, 255, 0.2);
        border-color: rgba(124, 92, 255, 0.55);
    }
    &.disabled {
        opacity: 0.5;
    }
    &.pinned {
        box-shadow: inset 0 0 0 1px rgba(245, 158, 11, 0.28);
    }
    .t-row {
        display: flex;
        align-items: flex-start;
        gap: 8px;
    }
    .t-name {
        flex: 1;
        min-width: 0;
        font-size: var(--fs-msg-topic);
        font-family: 'JetBrains Mono', Consolas, monospace;
        color: var(--text-0);
        line-height: 1.45;
        word-break: break-all;
        user-select: text;
        cursor: text;
    }
    .pin-badge {
        flex: 0 0 auto;
        padding: 1px 6px;
        border-radius: 999px;
        background: rgba(245, 158, 11, 0.16);
        color: #fcd34d;
        font-size: 10px;
        font-weight: 700;
        line-height: 1.6;
    }
    .t-meta {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: var(--text-3);
        margin-top: 4px;
        .count {
            color: var(--accent-2);
            font-weight: 600;
        }
        .ago {
            font-family: 'JetBrains Mono', Consolas, monospace;
        }
    }
}

.scroll-area {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    position: relative;
    contain: strict;

    &.bordered {
        background: var(--panel-body-bg);
        border: 1px solid var(--border);
        border-radius: 10px;
    }
}

.history-footer {
    padding: 8px 6px 12px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    justify-content: center;
}
.history-index-hint {
    color: #fbbf24;
    font-size: 11px;
    line-height: 1.4;
    text-align: center;
}
.history-load-btn {
    min-width: 120px;
    height: 32px;
    padding: 0 14px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--input-bg);
    color: var(--text-2);
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;

    &:hover:not(:disabled) {
        color: var(--text-0);
        border-color: var(--border-strong);
        background: var(--card-hover-bg);
    }
    &:disabled {
        cursor: wait;
        opacity: 0.65;
    }
}


.msg-card {
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--card-bg);
    user-select: text;
    cursor: text;

    &:hover {
        border-color: var(--border-strong);
        background: var(--card-hover-bg);
    }

    .msg-head {
        display: flex;
        gap: 10px;
        align-items: baseline;
        font-size: var(--fs-msg-meta);
        flex-wrap: wrap;
        .time {
            color: var(--text-3);
            font-family: 'JetBrains Mono', Consolas, monospace;
            flex: 0 0 auto;
        }
        .topic {
            color: var(--accent-2);
            font-family: 'JetBrains Mono', Consolas, monospace;
            font-weight: 600;
            word-break: break-all;
            line-height: 1.4;
            font-size: var(--fs-msg-topic);
            user-select: text;
            cursor: text;
        }
        .msg-hint {
            margin-left: auto;
            color: var(--text-3);
            font-size: 10px;
            opacity: 0;
            transition: opacity 0.15s;
            user-select: none;
        }
    }
    &:hover .msg-head .msg-hint {
        opacity: 0.7;
    }
    .msg-body {
        margin: 4px 0 0;
        font-family: 'JetBrains Mono', Consolas, monospace;
        font-size: var(--fs-msg);
        color: var(--text-1);
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-all;
        background: transparent;
        padding: 0;
    }
}

.ctx {
    position: fixed;
    background: var(--bg-1);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    padding: 4px;
    z-index: 1000;
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    min-width: 140px;

    button {
        background: transparent;
        color: var(--text-1);
        border: none;
        padding: 6px 10px;
        text-align: left;
        border-radius: 4px;
        font-size: 12px;
        cursor: pointer;
        &:hover {
            background: var(--card-hover-bg);
        }
    }
}
</style>
