/** 主进程与渲染进程共享的纯类型。不要引入任何运行时依赖。 */

export type MqttProtocol = 'mqtt://' | 'mqtts://' | 'ws://' | 'wss://';

export interface ConnectionConfig {
    id: string;
    name: string;
    protocol: MqttProtocol;
    host: string;
    port: number;
    path: string;
    username: string;
    password: string;
    clientId: string;
    subscriptions: SubscriptionConfig[];
    disabledTopics: string[];
    createdAt: number;
    updatedAt: number;
}

export interface SubscriptionConfig {
    topic: string;
    qos: 0 | 1 | 2;
    paused?: boolean;
}

export interface ConnectionsFile {
    connections: ConnectionConfig[];
    selectedId: string | null;
}

export interface AppSettings {
    autoDeleteDays: number;
    maxMemoryMessages: number;
    maxPerTopic: number;
    logDir: string;
}

export interface LogDirChangeInfo {
    changed: boolean;
    sourceDir: string;
    targetDir: string;
    sourceFiles: number;
}

export interface LogDirDataResult {
    files: number;
    sourceDir: string;
    targetDir?: string;
}

/** 批量从主进程推到渲染进程的单条消息 */
export interface MqttMessage {
    connectionId: string;
    topic: string;
    payload: string;
    time: number;
    seq: number;
}

export interface ConnectPayload {
    connectionId: string;
    protocol: MqttProtocol;
    host: string;
    port: number;
    path: string;
    username?: string;
    password?: string;
    clientId: string;
    disabledTopics: string[];
}

export interface PublishPayload {
    topic: string;
    payload: string;
    qos: 0 | 1 | 2;
    retain: boolean;
}

export interface HistoryQueryOptions {
    connectionId?: string | null;
    startTime?: number;
    endTime?: number;
    keyword?: string;
    keywords?: string[];
    keywordLogic?: 'and' | 'or';
    conditions?: HistoryKeywordCondition[];
    topic?: string;
    order?: 'desc' | 'asc';
    limit?: number;
    offset?: number;
}

export interface HistoryMessage {
    connectionId: string;
    topic: string;
    payload: string;
    time: number;
}

export interface HistoryQueryStreamStartRequest {
    requestId: string;
    opts: HistoryQueryOptions;
    chunkSize?: number;
}

export interface HistoryQueryStreamCancelRequest {
    requestId: string;
}

export interface HistoryQueryChunk {
    requestId: string;
    rows: HistoryMessage[];
}

export interface HistoryQueryDone {
    requestId: string;
    total: number;
    truncated: boolean;
}

export type HistoryKeywordJoin = 'and' | 'or' | 'not';

export interface HistoryKeywordCondition {
    term: string;
    join: HistoryKeywordJoin;
}

export interface HistoryExportRequest {
    format: 'json' | 'zip';
    query: Omit<HistoryQueryOptions, 'limit' | 'offset' | 'keyword' | 'keywords' | 'keywordLogic'>;
    conditions: HistoryKeywordCondition[];
}

export interface HistoryExportResult {
    filePath: string;
    dirPath: string;
    format: 'json' | 'zip';
    totalRows: number;
}

export interface HistoryExportProgress {
    stage: 'preparing' | 'writing' | 'packaging' | 'done' | 'error';
    processed: number;
    written: number;
    total?: number;
    percent?: number;
    rate?: number;
    message?: string;
    filePath?: string;
    dirPath?: string;
    format?: 'json' | 'zip';
}

export interface HistoryIndexStatus {
    totalFiles: number;
    indexedFiles: number;
    incompleteFiles: number;
    totalMessages: number;
    fts5Enabled: boolean;
}

export interface HistoryIndexRequest {
    connectionId?: string | null;
}

export interface HistoryIndexResult extends HistoryIndexStatus {
    processedFiles: number;
    processedBuckets: number;
    processedMessages: number;
}

export interface HistoryIndexProgress {
    stage: 'checking' | 'indexing' | 'done' | 'error';
    connectionId?: string;
    filePath?: string;
    processedFiles: number;
    totalFiles: number;
    processedBuckets: number;
    processedMessages: number;
    totalBuckets?: number;
    percent?: number;
    message?: string;
    fts5Enabled?: boolean;
}

export interface ApiResult<T = unknown> {
    success: boolean;
    message?: string;
    data?: T;
}

export interface UpdateInfo {
    currentVersion: string;
    latestVersion: string;
    hasUpdate: boolean;
    releaseUrl: string;
    releaseName?: string;
    publishedAt?: string;
    body?: string;
}

export type IpcChannels = {
    'mqtt:connect': (p: ConnectPayload) => ApiResult;
    'mqtt:disconnect': (connectionId: string) => ApiResult;
    'mqtt:subscribe': (p: { connectionId: string; topic: string; qos: 0 | 1 | 2 }) => ApiResult;
    'mqtt:unsubscribe': (p: { connectionId: string; topic: string }) => ApiResult;
    'mqtt:publish': (p: { connectionId: string } & PublishPayload) => ApiResult;
    'mqtt:disableTopic': (p: { connectionId: string; topic: string }) => ApiResult;
    'mqtt:enableTopic': (p: { connectionId: string; topic: string }) => ApiResult;
    'mqtt:setPriorityTopic': (p: { connectionId: string; topic: string | null }) => ApiResult;
    'mqtt:setActiveConnection': (p: { connectionId: string | null }) => ApiResult;
    'mqtt:setDisplayPaused': (p: { connectionId: string; paused: boolean }) => ApiResult;
    'mqtt:readRecent': (p: { connectionId: string; limit?: number }) => ApiResult<HistoryMessage[]>;
    'mqtt:clearLogs': (connectionId?: string | null) => ApiResult<{ deletedFiles: number }>;
    'history:query': (opts: HistoryQueryOptions) => ApiResult<HistoryMessage[]>;
    'history:queryStreamStart': (req: HistoryQueryStreamStartRequest) => ApiResult<{ requestId: string }>;
    'history:queryStreamCancel': (req: HistoryQueryStreamCancelRequest) => ApiResult<{ requestId: string }>;
    'history:export': (req: HistoryExportRequest) => ApiResult<HistoryExportResult>;
    'history:indexStatus': (req?: HistoryIndexRequest) => ApiResult<HistoryIndexStatus>;
    'history:buildIndex': (req?: HistoryIndexRequest) => ApiResult<HistoryIndexResult>;
    'history:openExportDir': (filePath: string) => ApiResult;
    'config:read': () => ApiResult<ConnectionsFile>;
    'config:write': (data: ConnectionsFile) => ApiResult;
    'settings:get': () => ApiResult<AppSettings>;
    'settings:set': (s: AppSettings) => ApiResult<{ needRestart: boolean }>;
    'settings:getLogDirChangeInfo': (logDir: string) => ApiResult<LogDirChangeInfo>;
    'settings:migrateLogDirData': (p: { sourceDir: string; targetDir: string }) => ApiResult<LogDirDataResult>;
    'settings:deleteLogDirData': (p: { sourceDir: string }) => ApiResult<LogDirDataResult>;
    'settings:getDefaultLogDir': () => ApiResult<string>;
    'settings:getCurrentLogDir': () => ApiResult<string>;
    'settings:chooseLogDir': () => ApiResult<{ path: string } | null>;
    'settings:openLogDir': (p?: string) => ApiResult;
    'app:relaunch': () => ApiResult;
    'app:getStartTime': () => ApiResult<number>;
    'app:getVersion': () => ApiResult<string>;
    'app:checkForUpdates': () => ApiResult<UpdateInfo>;
    'app:openReleasesPage': (url?: string) => ApiResult;
};

export type IpcEvents = {
    'mqtt:messages': (batch: MqttMessage[]) => void;
    'mqtt:state': (p: { connectionId: string; state: 'connected' | 'reconnecting' | 'offline' | 'closed' | 'error'; message?: string }) => void;
    'app:autoDeleteDone': (files: number) => void;
    'window:focused': () => void;
    'history:exportProgress': (p: HistoryExportProgress) => void;
    'history:indexProgress': (p: HistoryIndexProgress) => void;
    'history:queryChunk': (p: HistoryQueryChunk) => void;
    'history:queryDone': (p: HistoryQueryDone) => void;
    'history:queryError': (p: { requestId: string; message: string }) => void;
};
