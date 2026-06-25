
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useConnectionStore } from '@/stores/connection';
import { useToast } from '@/composables/useToast';
import { useFormatViewer } from '@/composables/useFormatViewer';
import { useMqttReplay, type ReplaySpeed } from '@/composables/useMqttReplay';
import type {
    HistoryExportProgress,
    HistoryExportRequest,
    HistoryIndexProgress,
    HistoryIndexStatus,
    HistoryKeywordCondition,
    HistoryMessage,
    HistoryQueryDone
} from '@shared/types';
import { datetimeLocalToTs, formatTime, shortTime, tsToDatetimeLocal } from '@/utils/format';
import { exportMqttxJson, exportGroupedZip } from '@/utils/exporter';
import { parseReplayFile, replayRowsFromHistory, type ReplayMessage } from '@/utils/replay';
import { highlight, type SearchLogic } from '@/utils/filter';

const formatViewer = useFormatViewer();
const replay = useMqttReplay();
const conn = useConnectionStore();
const toast = useToast();

type KeywordJoin = SearchLogic | 'not';
interface KeywordCondition {
    term: string;
    join: KeywordJoin;
}
interface ExportDialogState {
    open: boolean;
    running: boolean;
    stage: HistoryExportProgress['stage'] | 'idle';
    format: 'json' | 'zip' | null;
    processed: number;
    written: number;
    total: number;
    percent: number;
    rate: number;
    etaSeconds: number;
    message: string;
    filePath: string;
    dirPath: string;
}

interface IndexState {
    running: boolean;
    status: HistoryIndexStatus | null;
    progress: HistoryIndexProgress | null;
    message: string;
}

const startTime = ref<string>('');
const endTime = ref<string>('');
const keywordConditions = ref<KeywordCondition[]>([{ term: '', join: 'and' }]);
const scope = ref<'current' | 'all'>('current');
const historyOrder = ref<'desc' | 'asc'>('desc');
const rows = ref<HistoryMessage[]>([]);
const dataSource = ref<'history' | 'imported'>('history');
const selectedTopic = ref<string | null>(null);
const loading = ref(false);
const loadingMore = ref(false);
const exporting = ref(false);
const queryLimit = ref(500);
const hasMoreHistory = ref(false);
const topicScrollEl = ref<HTMLElement | null>(null);
const detailScrollEl = ref<HTMLElement | null>(null);
const detailVisibleCount = ref(120);
const topicVisibleCount = ref(200);
const DETAIL_BATCH = 120;
const TOPIC_BATCH = 200;
const HISTORY_STREAM_CHUNK_SIZE = 1000;

let historyStreamSeq = 0;
let activeHistoryStreamId: string | null = null;
let pendingHistoryRows: HistoryMessage[] = [];
let pendingHistoryFlush = 0;

const replayQos = ref<0 | 1 | 2>(0);
const replayRetain = ref(false);
const replaySpeed = ref<ReplaySpeed>('1x');
const replayLoop = ref(false);
const replayRewriteTimestamps = ref(false);
const importedRows = ref<ReplayMessage[]>([]);
const importedName = ref('');
const fileInput = ref<HTMLInputElement | null>(null);

type TopicSort = 'name' | 'count' | 'recent';
const topicSort = ref<TopicSort>('name');
const indexState = ref<IndexState>({
    running: false,
    status: null,
    progress: null,
    message: ''
});
const exportDialog = ref<ExportDialogState>({
    open: false,
    running: false,
    stage: 'idle',
    format: null,
    processed: 0,
    written: 0,
    total: 0,
    percent: 0,
    rate: 0,
    etaSeconds: 0,
    message: '',
    filePath: '',
    dirPath: ''
});

interface TopicGroup {
    topic: string;
    items: HistoryMessage[];
    lastTime: number;
}

const canReplayToMqtt = computed(() => Boolean(conn.selectedId) && conn.selectedState === 'connected');
const replaySourceRows = ref<HistoryMessage[]>([]);
const importedHistoryRows = computed<HistoryMessage[]>(() => importedRows.value.map((row) => ({
    connectionId: conn.selectedId || 'imported',
    topic: row.topic,
    payload: row.payload,
    time: row.time
})));
const replayPreviewRows = computed<HistoryMessage[]>(() => {
    if (!replay.state.running || replaySourceRows.value.length === 0) return [];
    const end = replay.state.currentIndex >= 0 ? Math.min(replay.state.currentIndex + 1, replaySourceRows.value.length) : 0;
    return replaySourceRows.value.slice(0, end);
});
const displayRows = computed<HistoryMessage[]>(() => {
    if (replay.state.running) return replayPreviewRows.value;
    return dataSource.value === 'imported' ? importedHistoryRows.value : rows.value;
});
const replayHint = computed(() => {
    if (!conn.selectedId) return '请先选择一个目标连接';
    if (conn.selectedState !== 'connected') return '目标连接需要处于已连接状态';
    return `将真实发布到当前连接：${conn.selected?.name || conn.selectedId}`;
});

const grouped = computed<TopicGroup[]>(() => {
    const m = new Map<string, { items: HistoryMessage[]; lastTime: number }>();
    for (const r of displayRows.value) {
        let g = m.get(r.topic);
        if (!g) {
            g = { items: [], lastTime: 0 };
            m.set(r.topic, g);
        }
        g.items.push(r);
        if (r.time > g.lastTime) g.lastTime = r.time;
    }
    const list: TopicGroup[] = [];
    for (const [topic, g] of m) list.push({ topic, items: g.items, lastTime: g.lastTime });
    switch (topicSort.value) {
        case 'count': list.sort((a, b) => b.items.length - a.items.length); break;
        case 'recent': list.sort((a, b) => b.lastTime - a.lastTime); break;
        case 'name':
        default: list.sort((a, b) => a.topic.localeCompare(b.topic)); break;
    }
    return list;
});

const detail = computed<HistoryMessage[]>(() => {
    if (!selectedTopic.value) return [];
    const matched = displayRows.value.filter((r) => r.topic === selectedTopic.value);
    return replay.state.running ? matched.slice().reverse() : matched;
});
const visibleDetail = computed<HistoryMessage[]>(() => detail.value.slice(0, detailVisibleCount.value));
const visibleTopics = computed<TopicGroup[]>(() => grouped.value.slice(0, topicVisibleCount.value));
const visibleCountLabel = computed(() => displayRows.value.length);
const dataSourceLabel = computed(() => {
    if (replay.state.running) return `回放预览：${replay.state.sourceName}`;
    return dataSource.value === 'imported' ? `导入数据：${importedName.value || '未命名文件'}` : '历史查询结果';
});
const indexSummary = computed(() => {
    if (indexState.value.running && indexState.value.progress) {
        const p = indexState.value.progress;
        const percent = p.percent != null ? ` ${Math.round(p.percent)}%` : '';
        return `正在建立历史索引${percent}：${p.processedFiles}/${p.totalFiles} 个文件，${p.processedMessages.toLocaleString()} 条消息`;
    }
    const status = indexState.value.status;
    if (!status || status.totalFiles === 0) return '暂无历史日志文件需要索引';
    if (status.incompleteFiles > 0) return `有 ${status.incompleteFiles}/${status.totalFiles} 个历史文件未建立索引，条件查询可能较慢`;
    return `历史索引已完成：${status.indexedFiles} 个文件，${status.totalMessages.toLocaleString()} 条消息`;
});

function activeKeywordConditions(): HistoryKeywordCondition[] {
    return keywordConditions.value
        .map((item) => ({ term: item.term.trim(), join: item.join }))
        .filter((item) => item.term);
}

function nextHistoryStreamId(): string {
    historyStreamSeq++;
    return `history-${Date.now()}-${historyStreamSeq}`;
}

function flushPendingHistoryRows(): void {
    pendingHistoryFlush = 0;
    if (!pendingHistoryRows.length) return;
    rows.value.push(...pendingHistoryRows.splice(0));
}

function queueHistoryRows(chunkRows: HistoryMessage[]): void {
    if (!chunkRows.length) return;
    pendingHistoryRows.push(...chunkRows);
    if (pendingHistoryFlush) return;
    pendingHistoryFlush = window.setTimeout(flushPendingHistoryRows, 16);
}

async function cancelActiveHistoryStream(): Promise<void> {
    const requestId = activeHistoryStreamId;
    activeHistoryStreamId = null;
    pendingHistoryRows = [];
    if (pendingHistoryFlush) {
        window.clearTimeout(pendingHistoryFlush);
        pendingHistoryFlush = 0;
    }
    if (requestId) await window.api.historyQueryStreamCancel({ requestId });
}

async function loadHistoryPage(offset: number): Promise<HistoryMessage[] | null> {
    const r = await window.api.historyQuery({
        ...buildHistoryQueryOptions(queryLimit.value + 1, offset),
        conditions: activeKeywordConditions()
    });
    if (!r.success || !r.data) {
        toast.error('查询失败：' + (r.message || ''));
        return null;
    }
    hasMoreHistory.value = r.data.length > queryLimit.value;
    return r.data.slice(0, queryLimit.value);
}

async function query(): Promise<void> {
    await cancelActiveHistoryStream();
    const requestId = nextHistoryStreamId();
    activeHistoryStreamId = requestId;
    hasMoreHistory.value = false;
    loading.value = true;
    rows.value = [];
    dataSource.value = 'history';
    selectedTopic.value = null;
    topicVisibleCount.value = TOPIC_BATCH;
    try {
        const r = await window.api.historyQueryStreamStart({
            requestId,
            opts: {
                ...buildHistoryQueryOptions(queryLimit.value + 1, 0),
                conditions: activeKeywordConditions()
            },
            chunkSize: HISTORY_STREAM_CHUNK_SIZE
        });
        if (!r.success) {
            activeHistoryStreamId = null;
            loading.value = false;
            toast.error('查询失败：' + (r.message || ''));
        }
    } catch (error) {
        activeHistoryStreamId = null;
        loading.value = false;
        toast.error('查询失败：' + ((error as Error).message || ''));
    }
}

function addKeywordCondition(): void {
    keywordConditions.value.push({ term: '', join: 'and' });
}

function removeKeywordCondition(index: number): void {
    if (keywordConditions.value.length <= 1) {
        keywordConditions.value[0].term = '';
        keywordConditions.value[0].join = 'and';
        return;
    }
    keywordConditions.value.splice(index, 1);
}

let appStart = 0;
async function refreshIndexStatus(): Promise<void> {
    const r = await window.api.historyIndexStatus({ connectionId: scope.value === 'current' ? conn.selectedId : null });
    if (r.success && r.data) indexState.value.status = r.data;
}

async function buildIndex(): Promise<void> {
    if (indexState.value.running) return;
    indexState.value.running = true;
    indexState.value.progress = null;
    indexState.value.message = '正在启动索引任务...';
    try {
        const r = await window.api.historyBuildIndex({ connectionId: scope.value === 'current' ? conn.selectedId : null });
        if (!r.success || !r.data) {
            toast.error('索引建立失败：' + (r.message || ''));
            return;
        }
        indexState.value.status = r.data;
        toast.success(`索引完成：${r.data.processedMessages.toLocaleString()} 条消息`);
    } finally {
        indexState.value.running = false;
        await refreshIndexStatus();
    }
}

async function init(): Promise<void> {
    const r = await window.api.appGetStartTime();
    if (r.success && r.data) {
        appStart = r.data;
        startTime.value = tsToDatetimeLocal(r.data);
    }
    endTime.value = tsToDatetimeLocal(Date.now());
    void refreshIndexStatus();
}

function setEndNow(): void {
    endTime.value = tsToDatetimeLocal(Date.now());
}

interface Quick {
    key: string;
    label: string;
    apply: () => void;
}

function startOfDay(ts: number): number {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

const quickRanges: Quick[] = [
    { key: '5m', label: '5 分钟', apply: () => setLast(5 * 60 * 1000) },
    { key: '15m', label: '15 分钟', apply: () => setLast(15 * 60 * 1000) },
    { key: '1h', label: '1 小时', apply: () => setLast(60 * 60 * 1000) },
    { key: '6h', label: '6 小时', apply: () => setLast(6 * 60 * 60 * 1000) },
    { key: '24h', label: '24 小时', apply: () => setLast(24 * 60 * 60 * 1000) },
    { key: '7d', label: '7 天', apply: () => setLast(7 * 24 * 60 * 60 * 1000) },
    { key: '30d', label: '30 天', apply: () => setLast(30 * 24 * 60 * 60 * 1000) },
    { key: 'today', label: '今天', apply: () => setRange(startOfDay(Date.now()), Date.now()) },
    {
        key: 'yesterday',
        label: '昨天',
        apply: () => {
            const todayStart = startOfDay(Date.now());
            setRange(todayStart - 86_400_000, todayStart - 1);
        }
    },
    {
        key: 'boot',
        label: '本次启动',
        apply: () => setRange(appStart || Date.now() - 3600_000, Date.now())
    },
    { key: 'all', label: '全部', apply: () => setRange(0, Date.now()) }
];
const activeQuick = ref<string>('boot');

function setLast(ms: number): void {
    const now = Date.now();
    setRange(now - ms, now);
}
function setRange(st: number, et: number): void {
    startTime.value = st > 0 ? tsToDatetimeLocal(st) : '';
    endTime.value = tsToDatetimeLocal(et);
}
function pickQuick(q: Quick): void {
    activeQuick.value = q.key;
    q.apply();
}

function buildHistoryQueryOptions(limit: number, offset = 0) {
    const st = datetimeLocalToTs(startTime.value);
    const et = datetimeLocalToTs(endTime.value);
    return {
        connectionId: scope.value === 'current' ? conn.selectedId : null,
        startTime: st || undefined,
        endTime: et || undefined,
        conditions: activeKeywordConditions(),
        order: historyOrder.value,
        limit,
        offset
    } as const;
}

function buildExportRequest(format: 'json' | 'zip'): HistoryExportRequest {
    return {
        format,
        query: {
            connectionId: scope.value === 'current' ? conn.selectedId : null,
            startTime: datetimeLocalToTs(startTime.value) || undefined,
            endTime: datetimeLocalToTs(endTime.value) || undefined
        },
        conditions: activeKeywordConditions()
    };
}

async function collectRowsForExport(): Promise<HistoryMessage[]> {
    if (dataSource.value !== 'history') return displayRows.value;
    const batchSize = 20_000;
    const all: HistoryMessage[] = [];
    let offset = 0;
    while (true) {
        const r = await window.api.historyQuery(buildHistoryQueryOptions(batchSize, offset));
        if (!r.success || !r.data) {
            throw new Error(r.message || '查询历史失败');
        }
        all.push(...r.data);
        if (r.data.length < batchSize) break;
        offset += r.data.length;
    }
    return all;
}

async function withExportRows(action: (rows: HistoryMessage[]) => Promise<void> | void): Promise<void> {
    if (!displayRows.value.length) { toast.warning('没有结果可导出'); return; }
    exporting.value = true;
    try {
        const exportRows = await collectRowsForExport();
        if (!exportRows.length) {
            toast.warning('没有结果可导出');
            return;
        }
        await action(exportRows);
        toast.success(`已导出 ${exportRows.length} 条`);
    } catch (error) {
        toast.error((error as Error).message || '导出失败');
    } finally {
        exporting.value = false;
    }
}

async function exportJson(): Promise<void> {
    if (dataSource.value === 'imported') {
        await withExportRows((exportRows) => {
            exportMqttxJson(exportRows, `history-${Date.now()}.json`);
        });
        return;
    }
    await runNativeExport('json');
}
async function exportZip(): Promise<void> {
    if (dataSource.value === 'imported') {
        await withExportRows(async (exportRows) => {
            await exportGroupedZip(exportRows, `history-grouped-${Date.now()}.zip`);
        });
        return;
    }
    await runNativeExport('zip');
}

function resetExportDialog(format: 'json' | 'zip'): void {
    exportDialog.value = {
        open: true,
        running: true,
        stage: 'preparing',
        format,
        processed: 0,
        written: 0,
        total: 0,
        percent: 0,
        rate: 0,
        etaSeconds: 0,
        message: '正在准备导出任务...',
        filePath: '',
        dirPath: ''
    };
}

function closeExportDialog(): void {
    if (exportDialog.value.running) return;
    exportDialog.value.open = false;
}

function formatEta(seconds: number): string {
    if (seconds <= 0) return '即将完成';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}小时${m}分`;
    if (m > 0) return `${m}分${s}秒`;
    return `${s}秒`;
}

async function openExportDir(): Promise<void> {
    if (!exportDialog.value.filePath) return;
    await window.api.historyOpenExportDir(exportDialog.value.filePath);
}

async function runNativeExport(format: 'json' | 'zip'): Promise<void> {
    if (!displayRows.value.length) { toast.warning('没有结果可导出'); return; }
    if (exporting.value) return;
    exporting.value = true;
    resetExportDialog(format);
    try {
        const result = await window.api.historyExport(buildExportRequest(format));
        if (result.success && result.data) {
            exportDialog.value.running = false;
            exportDialog.value.stage = 'done';
            exportDialog.value.filePath = result.data.filePath;
            exportDialog.value.dirPath = result.data.dirPath;
            exportDialog.value.written = result.data.totalRows;
            exportDialog.value.total = Math.max(exportDialog.value.total, result.data.totalRows);
            exportDialog.value.percent = 100;
            exportDialog.value.etaSeconds = 0;
            exportDialog.value.message = `导出完成，共 ${result.data.totalRows.toLocaleString()} 条`;
            toast.success(`导出完成：${result.data.totalRows} 条`);
            return;
        }
        if (result.message === '已取消导出') {
            exportDialog.value.running = false;
            exportDialog.value.stage = 'idle';
            exportDialog.value.message = '已取消导出';
            exportDialog.value.open = false;
            return;
        }
        exportDialog.value.running = false;
        exportDialog.value.stage = 'error';
        exportDialog.value.message = result.message || '导出失败';
        toast.error(exportDialog.value.message);
    } catch (error) {
        exportDialog.value.running = false;
        exportDialog.value.stage = 'error';
        exportDialog.value.message = (error as Error).message || '导出失败';
        toast.error(exportDialog.value.message);
    } finally {
        exporting.value = false;
    }
}

function resetDetailWindow(): void {
    detailVisibleCount.value = DETAIL_BATCH;
    nextTick(() => {
        const el = detailScrollEl.value;
        if (el) el.scrollTop = 0;
    });
}

function loadMoreTopics(): void {
    if (topicVisibleCount.value >= grouped.value.length) return;
    topicVisibleCount.value = Math.min(grouped.value.length, topicVisibleCount.value + TOPIC_BATCH);
}

async function loadMoreHistory(): Promise<void> {
    if (activeHistoryStreamId) return;
    if (dataSource.value !== 'history' || loading.value || loadingMore.value || !hasMoreHistory.value) return;
    loadingMore.value = true;
    try {
        const page = await loadHistoryPage(rows.value.length);
        if (!page) return;
        rows.value.push(...page);
        if (!selectedTopic.value && rows.value.length) selectedTopic.value = rows.value[0].topic;
    } finally {
        loadingMore.value = false;
    }
}

function loadMoreDetail(): void {
    if (detailVisibleCount.value >= detail.value.length) return;
    detailVisibleCount.value = Math.min(detail.value.length, detailVisibleCount.value + DETAIL_BATCH);
}

async function onTopicScroll(): Promise<void> {
    const el = topicScrollEl.value;
    if (!el) return;
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 160) return;
    loadMoreTopics();
    await loadMoreHistory();
}

async function onDetailScroll(): Promise<void> {
    const el = detailScrollEl.value;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 160) {
        loadMoreDetail();
        if (visibleDetail.value.length >= detail.value.length) await loadMoreHistory();
    }
}

async function startReplayRows(sourceName: string, replayRows: ReplayMessage[]): Promise<void> {
    if (!conn.selectedId) {
        toast.error('请先选择目标连接');
        return;
    }
    if (conn.selectedState !== 'connected') {
        toast.error('目标连接未连接，无法真实重放');
        return;
    }
    if (!replayRows.length) {
        toast.warning('没有可回放的数据');
        return;
    }
    try {
        replaySourceRows.value = replayRows.map((row) => ({
            connectionId: conn.selectedId || 'replay',
            topic: row.topic,
            payload: row.payload,
            time: row.time
        }));
        selectedTopic.value = replaySourceRows.value[0]?.topic ?? null;
        await replay.start(sourceName, {
            connectionId: conn.selectedId,
            rows: replayRows,
            speed: replaySpeed.value,
            loop: replayLoop.value,
            timestampRewrite: replayRewriteTimestamps.value ? 'on' : 'off'
        });
    } catch (error) {
        toast.error((error as Error).message || '回放启动失败');
    }
}

async function replayHistoryRows(): Promise<void> {
    await startReplayRows('历史查询结果', replayRowsFromHistory(rows.value, replayQos.value, replayRetain.value));
}

function openImport(): void {
    fileInput.value?.click();
}

async function onImportChange(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    await cancelActiveHistoryStream();
    try {
        importedRows.value = await parseReplayFile(file);
        importedName.value = file.name;
        dataSource.value = 'imported';
        hasMoreHistory.value = false;
        selectedTopic.value = importedHistoryRows.value[0]?.topic ?? null;
        toast.success(`已导入 ${importedRows.value.length} 条回放数据`);
    } catch (error) {
        importedRows.value = [];
        importedName.value = '';
        toast.error((error as Error).message || '导入失败');
    } finally {
        input.value = '';
    }
}

async function replayImportedRows(): Promise<void> {
    await startReplayRows(importedName.value || '导入文件', importedRows.value);
}

async function replayPreferredRows(): Promise<void> {
    if (dataSource.value === 'imported' && importedRows.value.length) {
        await replayImportedRows();
        return;
    }
    await replayHistoryRows();
}

onMounted(init);

const offHistoryIndexProgress = window.api.onHistoryIndexProgress((progress) => {
    indexState.value.progress = progress;
    indexState.value.message = progress.message || indexState.value.message;
    if (progress.stage === 'done' || progress.stage === 'error') indexState.value.running = false;
});

const offHistoryExportProgress = window.api.onHistoryExportProgress((progress) => {
    if (!exportDialog.value.open) return;
    exportDialog.value.stage = progress.stage;
    exportDialog.value.processed = progress.processed;
    exportDialog.value.written = progress.written;
    exportDialog.value.total = progress.total ?? exportDialog.value.total;
    exportDialog.value.percent = progress.percent ?? exportDialog.value.percent;
    exportDialog.value.rate = progress.rate ?? exportDialog.value.rate;
    if (exportDialog.value.total > 0 && exportDialog.value.rate > 0) {
        exportDialog.value.etaSeconds = Math.max(
            0,
            Math.round((exportDialog.value.total - exportDialog.value.processed) / exportDialog.value.rate)
        );
    }
    exportDialog.value.message = progress.message || exportDialog.value.message;
    if (progress.filePath) exportDialog.value.filePath = progress.filePath;
    if (progress.dirPath) exportDialog.value.dirPath = progress.dirPath;
    if (progress.stage === 'done' || progress.stage === 'error') {
        exportDialog.value.running = false;
    }
});

const offHistoryQueryChunk = window.api.onHistoryQueryChunk((chunk) => {
    if (chunk.requestId !== activeHistoryStreamId) return;
    queueHistoryRows(chunk.rows);
});

function finishHistoryStream(done: HistoryQueryDone): void {
    if (done.requestId !== activeHistoryStreamId) return;
    flushPendingHistoryRows();
    activeHistoryStreamId = null;
    loading.value = false;
    hasMoreHistory.value = rows.value.length > queryLimit.value;
    if (hasMoreHistory.value) rows.value = rows.value.slice(0, queryLimit.value);
    selectedTopic.value = rows.value.length > 0 ? rows.value[0].topic : null;
    if (rows.value.length === 0) toast.info('无匹配结果');
    else toast.success(hasMoreHistory.value ? `已加载 ${rows.value.length} 条，向下滚动继续加载` : `找到 ${rows.value.length} 条`);
}

const offHistoryQueryDone = window.api.onHistoryQueryDone(finishHistoryStream);

const offHistoryQueryError = window.api.onHistoryQueryError((error) => {
    if (error.requestId !== activeHistoryStreamId) return;
    activeHistoryStreamId = null;
    pendingHistoryRows = [];
    if (pendingHistoryFlush) {
        window.clearTimeout(pendingHistoryFlush);
        pendingHistoryFlush = 0;
    }
    loading.value = false;
    toast.error('查询失败：' + error.message);
});

onBeforeUnmount(() => {
    offHistoryIndexProgress();
    offHistoryExportProgress();
    offHistoryQueryChunk();
    offHistoryQueryDone();
    offHistoryQueryError();
    void cancelActiveHistoryStream();
});

watch(
    () => [selectedTopic.value, replay.state.running, dataSource.value] as const,
    () => resetDetailWindow(),
    { flush: 'post' }
);

watch(
    () => replay.state.running,
    (running) => {
        if (running) return;
        replaySourceRows.value = [];
        const sourceRows = dataSource.value === 'imported' ? importedHistoryRows.value : rows.value;
        selectedTopic.value = sourceRows[0]?.topic ?? null;
    }
);
</script>

<template>
    <section class="panel">
        <div class="panel-head">
            <h2>历史查询</h2>
            <span class="spacer"></span>
            <button v-if="displayRows.length" class="btn btn-mini" :disabled="exporting" @click="exportJson" title="导出完整 JSON">
                {{ exporting ? '导出中...' : '导出 JSON' }}
            </button>
            <button v-if="displayRows.length" class="btn btn-mini" :disabled="exporting" @click="exportZip" title="按主题分组 ZIP">
                {{ exporting ? '导出中...' : '导出 ZIP' }}
            </button>
        </div>
        <div class="panel-body">
            <div class="controls">
                <div class="controls-main">
                    <div class="field">
                        <label>开始时间</label>
                        <input type="datetime-local" step="1" v-model="startTime" @input="activeQuick = ''" @keydown.enter="query" />
                    </div>
                    <div class="field">
                        <label>结束时间</label>
                        <div class="inline">
                            <input type="datetime-local" step="1" v-model="endTime" @input="activeQuick = ''" @keydown.enter="query" />
                            <button class="btn btn-mini" @click="setEndNow(); activeQuick = ''">当前</button>
                        </div>
                    </div>
                    <div class="field">
                        <label>连接范围</label>
                        <select v-model="scope" @keydown.enter="query">
                            <option value="current">当前连接</option>
                            <option value="all">全部连接</option>
                        </select>
                    </div>
                    <div class="field">
                        <label>显示顺序</label>
                        <select v-model="historyOrder" @keydown.enter="query">
                            <option value="desc">倒序（新→旧）</option>
                            <option value="asc">顺序（旧→新）</option>
                        </select>
                    </div>
                    <div class="field">
                        <label>结果上限</label>
                        <select v-model.number="queryLimit" @keydown.enter="query">
                            <option :value="500">500</option>
                            <option :value="1000">1,000</option>
                            <option :value="2000">2,000</option>
                            <option :value="5000">5,000</option>
                            <option :value="10000">10,000</option>
                        </select>
                    </div>
                    <button class="btn btn-primary query-btn" :disabled="loading" @click="query">
                        {{ loading ? '查询中...' : '查询' }}
                    </button>
                </div>
                <div class="field keyword-field">
                    <label>关键字</label>
                    <div class="filter-builder">
                        <div class="logic-anchor">条件</div>
                        <div class="filter-conditions">
                            <div v-for="(item, index) in keywordConditions" :key="index" class="filter-condition">
                                <span v-if="index === 0" class="condition-index">条件 1</span>
                                <div v-else class="logic-segment" role="tablist" :aria-label="`条件 ${index + 1} 逻辑`">
                                    <button class="seg-btn" :class="{ active: item.join === 'and' }" @click="item.join = 'and'">且</button>
                                    <button class="seg-btn" :class="{ active: item.join === 'or' }" @click="item.join = 'or'">或</button>
                                    <button class="seg-btn" :class="{ active: item.join === 'not' }" @click="item.join = 'not'">非</button>
                                </div>
                                <input v-model="item.term" placeholder="主题或内容" @keydown.enter="query" />
                                <button class="condition-btn" title="删除条件" @click="removeKeywordCondition(index)">×</button>
                            </div>
                        </div>
                        <button class="condition-add" title="添加过滤条件" @click="addKeywordCondition">+ 添加条件</button>
                    </div>
                </div>
            </div>
            <div class="quick-bar">
                <span class="quick-label">快速选择</span>
                <button
                    v-for="q in quickRanges"
                    :key="q.key"
                    class="chip"
                    :class="{ active: activeQuick === q.key }"
                    @click="pickQuick(q)"
                >{{ q.label }}</button>
            </div>
            <div class="query-note index-note" :class="{ warn: indexState.status?.incompleteFiles }">
                <span>{{ indexState.message || indexSummary }}</span>
                <button class="btn btn-mini" :disabled="indexState.running" @click="buildIndex">
                    {{ indexState.running ? '索引中...' : '建立/重建索引' }}
                </button>
            </div>
            <div v-if="(hasMoreHistory || loadingMore) && !loading" class="query-note">
                {{ loadingMore ? '正在加载更多历史结果...' : `已加载 ${rows.length.toLocaleString()} 条，继续向下滚动可加载更多。` }}
            </div>

            <div class="replay-panel">
                <div class="replay-head">
                    <strong>真实 MQTT 重放</strong>
                    <span class="replay-hint">{{ replayHint }}</span>
                </div>
                <div class="replay-grid">
                    <div class="field small">
                        <label>QoS</label>
                        <select v-model.number="replayQos">
                            <option :value="0">0</option>
                            <option :value="1">1</option>
                            <option :value="2">2</option>
                        </select>
                    </div>
                    <div class="field small">
                        <label>Retain</label>
                        <select :value="replayRetain ? 'true' : 'false'" @change="replayRetain = ($event.target as HTMLSelectElement).value === 'true'">
                            <option value="false">false</option>
                            <option value="true">true</option>
                        </select>
                    </div>
                    <div class="field small">
                        <label>节奏</label>
                        <select v-model="replaySpeed">
                            <option value="instant">立即发送</option>
                            <option value="10x">10x</option>
                            <option value="5x">5x</option>
                            <option value="2x">2x</option>
                            <option value="1x">1x</option>
                        </select>
                    </div>
                    <div class="replay-toggle-group">
                        <div
                            class="replay-switch-row"
                        >
                            <span class="replay-switch-label">
                                时间戳→当前
                                <span
                                    class="help-dot"
                                    title="仅对合法 JSON 生效：把 payload 里像 Unix 时间戳的数字改成发送当下的时间。毫秒级(≥1e12)改为当前毫秒，秒级(1e9~1e12)改为当前秒。"
                                >?</span>
                            </span>
                            <label class="switch" :title="replayRewriteTimestamps ? '已开启' : '已关闭'">
                                <input v-model="replayRewriteTimestamps" type="checkbox" />
                                <span class="slider" :class="{ on: replayRewriteTimestamps }"></span>
                            </label>
                        </div>
                        <div class="replay-switch-row" title="到最后一条后重新从头开始，直到手动停止">
                            <span class="replay-switch-label">循环播放</span>
                            <label class="switch" :title="replayLoop ? '已开启' : '已关闭'">
                                <input v-model="replayLoop" type="checkbox" />
                                <span class="slider" :class="{ on: replayLoop }"></span>
                            </label>
                        </div>
                    </div>
                    <div class="replay-actions">
                        <button class="btn" :disabled="replay.state.running" @click="openImport">导入文件</button>
                        <button
                            class="btn btn-primary replay-start"
                            :disabled="(!rows.length && !importedRows.length) || !canReplayToMqtt || replay.state.running"
                            @click="replayPreferredRows"
                        >开始重放</button>
                        <button class="btn btn-warning" :disabled="!replay.state.running" @click="replay.togglePause()">
                            {{ replay.state.paused ? '继续' : '暂停' }}
                        </button>
                        <button class="btn btn-danger" :disabled="!replay.state.running" @click="replay.stop()">停止</button>
                    </div>
                    <input ref="fileInput" type="file" accept=".json,.jsonl,.zip" class="hidden-file" @change="onImportChange" />
                </div>
                <div class="replay-meta">
                    <span>{{ dataSourceLabel }} / {{ visibleCountLabel }} 条</span>
                    <span v-if="replay.state.paused" class="replay-paused">已暂停</span>
                    <span v-if="replay.state.running">运行中：第 {{ replay.state.rounds }} 轮，已发送 {{ replay.state.sent }} 条，本轮总数 {{ replay.state.total }}，失败 {{ replay.state.failed }}</span>
                    <span v-else-if="replay.state.total">上次任务：{{ replay.state.sourceName }}，共发送 {{ replay.state.sent }} 条，本轮基数 {{ replay.state.total }}</span>
                    <span v-if="replay.state.lastError" class="replay-error">最近错误：{{ replay.state.lastError }}</span>
                </div>
            </div>

            <div v-if="displayRows.length === 0" class="empty">
                <div v-if="loading">查询中，请稍候...</div>
                <div v-else>设置时间范围和关键字后点击“查询”，或导入回放文件</div>
            </div>

            <div v-else class="split">
                <div class="topic-list">
                    <div class="t-head">
                        <span>主题（{{ grouped.length }}）</span>
                        <select class="sort-select" v-model="topicSort" title="排序方式">
                            <option value="name">主题名</option>
                            <option value="recent">最近活跃</option>
                            <option value="count">消息量</option>
                        </select>
                    </div>
                    <div ref="topicScrollEl" class="scroll-area" @scroll.passive="onTopicScroll">
                        <div class="t-list">
                            <div
                                v-for="g in visibleTopics"
                                :key="g.topic"
                                class="t-item"
                                :class="{ active: selectedTopic === g.topic }"
                                @click="selectedTopic = g.topic"
                            >
                                <div class="t-name" v-html="highlight(g.topic, keywordConditions.map((item) => item.term))"></div>
                                <div class="t-meta">
                                    <span class="count">{{ g.items.length }} 条</span>
                                    <span class="ago">{{ shortTime(g.lastTime) }}</span>
                                </div>
                            </div>
                            <button
                                v-if="visibleTopics.length < grouped.length || hasMoreHistory"
                                class="load-more-btn"
                                :disabled="loadingMore"
                                @click="loadMoreTopics(); loadMoreHistory()"
                            >{{ loadingMore ? '加载中...' : '加载更多' }}</button>
                        </div>
                    </div>
                </div>

                <div class="topic-detail">
                    <div class="t-head">
                        <template v-if="selectedTopic">
                            <span class="t-head-name" :title="selectedTopic">{{ selectedTopic }}</span>
                            <span class="t-head-count">{{ visibleDetail.length }} / {{ detail.length }} 条</span>
                        </template>
                        <span v-else class="sub-empty">请从左侧选择主题</span>
                    </div>
                    <div v-if="selectedTopic" ref="detailScrollEl" class="scroll-area" @scroll.passive="onDetailScroll">
                        <div v-if="detail.length === 0" class="empty small">该主题无匹配消息</div>
                        <div v-else class="msg-list">
                            <div
                                v-for="m in visibleDetail"
                                :key="m.topic + '|' + m.time + '|' + m.payload.length"
                                class="msg-card cv-auto"
                                @contextmenu.prevent="formatViewer.open({ topic: m.topic, time: m.time, raw: m.payload })"
                            >
                                <div class="msg-head">
                                    <span class="time">{{ formatTime(m.time) }}</span>
                                    <span class="msg-hint">右键格式化</span>
                                </div>
                                <pre class="msg-body" v-html="highlight(m.payload, keywordConditions.map((item) => item.term))"></pre>
                            </div>
                            <button
                                v-if="visibleDetail.length < detail.length"
                                class="load-more-btn"
                                @click="loadMoreDetail"
                            >加载更多</button>
                        </div>
                    </div>
                </div>
            </div>

            <div v-if="exportDialog.open" class="export-overlay" @click.self="closeExportDialog">
                <div class="export-modal">
                    <div class="export-title-row">
                        <div>
                            <h3>导出历史数据</h3>
                            <p>{{ exportDialog.format === 'zip' ? '按主题打包为 ZIP' : '导出为 JSON 文件' }}</p>
                        </div>
                        <button class="export-close" :disabled="exportDialog.running" @click="closeExportDialog">×</button>
                    </div>
                    <div class="export-progress-shell" :class="{ done: exportDialog.stage === 'done', error: exportDialog.stage === 'error' }">
                        <div
                            class="export-progress-bar"
                            :class="{ running: exportDialog.running && exportDialog.percent <= 0 }"
                            :style="exportDialog.percent > 0 ? { width: `${Math.max(6, exportDialog.percent)}%` } : undefined"
                        ></div>
                    </div>
                    <div class="export-stats">
                        <span>已扫描 {{ exportDialog.processed.toLocaleString() }} 条</span>
                        <span>已写入 {{ exportDialog.written.toLocaleString() }} 条</span>
                    </div>
                    <div class="export-stats">
                        <span>{{ exportDialog.total ? `总量 ${exportDialog.total.toLocaleString()} 条` : '正在统计总量...' }}</span>
                        <span>{{ exportDialog.rate ? `${Math.round(exportDialog.rate).toLocaleString()} 条/秒` : '计算速率中...' }}</span>
                    </div>
                    <div class="export-stats">
                        <span>{{ exportDialog.percent ? `已完成 ${Math.round(exportDialog.percent)}%` : '正在计算进度...' }}</span>
                        <span>{{ exportDialog.rate && exportDialog.total ? `预计剩余 ${formatEta(exportDialog.etaSeconds)}` : '预计时间计算中...' }}</span>
                    </div>
                    <div class="export-percent">{{ Math.round(exportDialog.percent) }}%</div>
                    <div class="export-message">{{ exportDialog.message || '正在导出...' }}</div>
                    <div v-if="exportDialog.filePath" class="export-path" :title="exportDialog.filePath">{{ exportDialog.filePath }}</div>
                    <div class="export-actions">
                        <button
                            class="btn"
                            :disabled="!exportDialog.filePath || exportDialog.running"
                            @click="openExportDir"
                        >打开目标目录</button>
                        <button class="btn btn-primary" :disabled="exportDialog.running" @click="closeExportDialog">完成</button>
                    </div>
                </div>
            </div>
        </div>
    </section>
</template>

<style lang="scss" scoped>
.panel-body {
    min-height: 0;
    position: relative;
}

.controls {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-bottom: 6px;
}

.controls-main {
    display: grid;
    grid-template-columns: minmax(220px, 1fr) minmax(220px, 1fr) minmax(140px, 180px) minmax(150px, 170px) minmax(120px, 140px) auto;
    gap: 8px;
    align-items: end;

    .inline {
        display: flex;
        gap: 4px;
        align-items: center;
        input {
            flex: 1;
            min-width: 0;
        }
    }

    .query-btn {
        align-self: end;
        height: 34px;
        padding: 0 18px;
    }

    .keyword-field {
        min-width: 0;
    }
}

.filter-builder {
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

    input {
        min-width: 0;
    }
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

.filter-condition input {
    height: 34px;
    padding: 0 12px;
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
    align-self: start;
}

@media (max-width: 1200px) {
    .controls-main {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        .query-btn {
            grid-column: 1 / -1;
        }
    }

    .filter-builder {
        grid-template-columns: 1fr;
        align-items: stretch;
    }

    .condition-add {
        justify-self: start;
    }
}

@media (max-width: 760px) {
    .controls-main {
        grid-template-columns: 1fr;
    }
}

.quick-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding: 4px 2px 8px;
    border-bottom: 1px dashed var(--border);
    margin-bottom: 10px;

    .quick-label {
        font-size: 11px;
        color: var(--text-3);
        margin-right: 2px;
    }

    .chip {
        background: var(--input-bg);
        border: 1px solid var(--border);
        color: var(--text-2);
        font-size: 11px;
        font-family: inherit;
        padding: 3px 10px;
        border-radius: 999px;
        cursor: pointer;

        &:hover {
            background: var(--card-hover-bg);
            color: var(--text-0);
            border-color: var(--border-strong);
        }
        &.active {
            background: rgba(124, 92, 255, 0.28);
            border-color: rgba(124, 92, 255, 0.55);
            color: #fff;
        }
    }
}

.query-note {
    margin: 2px 0 10px;
    padding: 8px 10px;
    border: 1px solid rgba(245, 158, 11, 0.28);
    border-radius: 8px;
    background: rgba(245, 158, 11, 0.08);
    color: #fcd34d;
    font-size: 12px;
}

.index-note {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: center;
    border-color: rgba(74, 222, 128, 0.28);
    background: rgba(34, 197, 94, 0.08);
    color: #86efac;

    &.warn {
        border-color: rgba(245, 158, 11, 0.28);
        background: rgba(245, 158, 11, 0.08);
        color: #fcd34d;
    }
}

.replay-panel {
    margin-bottom: 12px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--panel-body-bg);
}

.replay-head {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: baseline;
    margin-bottom: 8px;
}

.replay-hint {
    color: var(--text-3);
    font-size: 12px;
}

.replay-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: end;
}

.replay-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-left: auto;
}

.field.small {
    min-width: 110px;
}

.replay-toggle-group {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
}

.replay-switch-row {
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 34px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--input-bg);
}

.replay-grid > .btn {
    min-width: 120px;
}

.replay-start {
    min-width: 132px;
    font-weight: 700;
    text-align: center;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}

.replay-switch-label {
    font-size: 11px;
    font-weight: 700;
    color: var(--text-2);
    white-space: nowrap;
}

.help-dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    margin-left: 4px;
    border-radius: 50%;
    border: 1px solid var(--border-strong);
    color: var(--text-2);
    font-size: 10px;
    line-height: 1;
    cursor: help;
}

.replay-switch-row .switch {
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
    }
}

.hidden-file {
    display: none;
}

.replay-meta {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 8px;
    color: var(--text-2);
    font-size: 12px;
    padding-top: 8px;
    border-top: 1px dashed var(--border);
}

.replay-error {
    color: #fca5a5;
}

.replay-paused {
    color: #fcd34d;
    font-weight: 700;
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
    background: var(--panel-body-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 0;
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
    flex: 0 0 auto;
}
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
.t-head-count {
    flex: 0 0 auto;
    font-weight: 400;
    color: var(--text-3);
    font-size: 11px;
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

.sub-empty {
    color: var(--text-3);
    font-weight: 400;
}

.scroll-area {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
}

.cv-auto {
    content-visibility: auto;
    contain-intrinsic-size: auto 80px;
}

.t-list {
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.t-item {
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--card-bg);
    cursor: pointer;

    &:hover {
        background: var(--card-hover-bg);
        border-color: var(--border-strong);
    }
    &.active {
        background: rgba(124, 92, 255, 0.2);
        border-color: rgba(124, 92, 255, 0.55);
    }
    &.replaying {
        border-color: rgba(16, 185, 129, 0.45);
        box-shadow: inset 0 0 0 1px rgba(16, 185, 129, 0.18);
    }

    .t-name {
        font-size: var(--fs-msg-topic);
        font-family: 'JetBrains Mono', Consolas, monospace;
        color: var(--text-0);
        line-height: 1.45;
        word-break: break-all;
        user-select: text;
        cursor: text;
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

.msg-list {
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.load-more-btn {
    height: 34px;
    border: 1px dashed var(--border-strong);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.02);
    color: var(--text-2);
    font-family: inherit;
    cursor: pointer;

    &:hover {
        color: var(--text-0);
        background: var(--card-hover-bg);
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
    &.replaying {
        border-color: rgba(16, 185, 129, 0.55);
        background: rgba(16, 185, 129, 0.08);
        box-shadow: inset 0 0 0 1px rgba(16, 185, 129, 0.18);
    }

    .msg-head {
        font-size: var(--fs-msg-meta);
        display: flex;
        align-items: baseline;
        gap: 10px;

        .time {
            color: var(--text-3);
            font-family: 'JetBrains Mono', Consolas, monospace;
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

.empty {
    color: var(--text-3);
    font-size: 12px;
    text-align: center;
    padding: 40px 20px;

    &.small {
        padding: 16px 10px;
    }
}

.export-overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(2, 6, 23, 0.52);
    backdrop-filter: blur(4px);
    z-index: 30;
}

.export-modal {
    width: min(520px, calc(100% - 32px));
    padding: 18px;
    border-radius: 16px;
    border: 1px solid var(--border-strong);
    background: linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(15, 23, 42, 0.94));
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.35);
}

.export-title-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;

    h3 {
        margin: 0;
        font-size: 18px;
        color: var(--text-0);
    }

    p {
        margin: 4px 0 0;
        font-size: 12px;
        color: var(--text-3);
    }
}

.export-close {
    width: 30px;
    height: 30px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: transparent;
    color: var(--text-2);
    font-size: 18px;
    cursor: pointer;
}

.export-progress-shell {
    position: relative;
    height: 14px;
    overflow: hidden;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: rgba(255, 255, 255, 0.05);

    &.done .export-progress-bar {
        width: 100%;
        animation: none;
        background: linear-gradient(90deg, #22c55e, #4ade80);
    }

    &.error .export-progress-bar {
        width: 100%;
        animation: none;
        background: linear-gradient(90deg, #ef4444, #f87171);
    }
}

.export-progress-bar {
    position: absolute;
    inset: 0 auto 0 0;
    width: 42%;
    border-radius: inherit;
    background: linear-gradient(90deg, rgba(91, 141, 239, 0.9), rgba(124, 92, 255, 0.95), rgba(91, 141, 239, 0.9));
    background-size: 220px 100%;

    &.running {
        animation: export-slide 1.2s linear infinite;
    }
}

.export-stats {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-top: 12px;
    color: var(--text-2);
    font-size: 12px;
    font-family: 'JetBrains Mono', Consolas, monospace;
}

.export-message {
    margin-top: 10px;
    color: var(--text-1);
    font-size: 13px;
    line-height: 1.5;
}

.export-percent {
    margin-top: 10px;
    color: var(--text-0);
    font-size: 22px;
    font-weight: 700;
    font-family: 'JetBrains Mono', Consolas, monospace;
}

.export-path {
    margin-top: 10px;
    padding: 10px 12px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    color: var(--text-3);
    font-size: 12px;
    font-family: 'JetBrains Mono', Consolas, monospace;
    word-break: break-all;
}

.export-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
}

@keyframes export-slide {
    0% {
        transform: translateX(-55%);
    }
    100% {
        transform: translateX(240%);
    }
}
</style>
