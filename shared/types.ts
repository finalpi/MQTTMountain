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
    topic?: string;
    limit?: number;
    offset?: number;
}

export interface HistoryMessage {
    connectionId: string;
    topic: string;
    payload: string;
    time: number;
}

export interface ApiResult<T = unknown> {
    success: boolean;
    message?: string;
    data?: T;
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
    'mqtt:readRecent': (p: { connectionId: string; limit?: number }) => ApiResult<HistoryMessage[]>;
    'mqtt:clearLogs': (connectionId?: string | null) => ApiResult<{ deletedFiles: number }>;
    'history:query': (opts: HistoryQueryOptions) => ApiResult<HistoryMessage[]>;
    'config:read': () => ApiResult<ConnectionsFile>;
    'config:write': (data: ConnectionsFile) => ApiResult;
    'settings:get': () => ApiResult<AppSettings>;
    'settings:set': (s: AppSettings) => ApiResult<{ needRestart: boolean }>;
    'settings:getDefaultLogDir': () => ApiResult<string>;
    'settings:getCurrentLogDir': () => ApiResult<string>;
    'settings:chooseLogDir': () => ApiResult<{ path: string } | null>;
    'settings:openLogDir': (p?: string) => ApiResult;
    'app:relaunch': () => ApiResult;
    'app:getStartTime': () => ApiResult<number>;
};

export type IpcEvents = {
    'mqtt:messages': (batch: MqttMessage[]) => void;
    'mqtt:state': (p: { connectionId: string; state: 'connected' | 'reconnecting' | 'offline' | 'closed' | 'error'; message?: string }) => void;
    'app:autoDeleteDone': (files: number) => void;
    'window:focused': () => void;
};
