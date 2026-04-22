import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type {
    AppSettings,
    ConnectionsFile,
    ConnectPayload,
    HistoryQueryOptions,
    HistoryMessage,
    MqttMessage,
    PublishPayload,
    ApiResult
} from '../../shared/types';

const invoke = <T = unknown>(ch: string, ...args: unknown[]) =>
    ipcRenderer.invoke(ch, ...args) as Promise<ApiResult<T>>;

const api = {
    mqttConnect: (p: ConnectPayload) => invoke('mqtt:connect', p),
    mqttDisconnect: (id: string) => invoke('mqtt:disconnect', id),
    mqttSubscribe: (p: { connectionId: string; topic: string; qos: 0 | 1 | 2 }) => invoke('mqtt:subscribe', p),
    mqttUnsubscribe: (p: { connectionId: string; topic: string }) => invoke('mqtt:unsubscribe', p),
    mqttPublish: (p: { connectionId: string } & PublishPayload) => invoke('mqtt:publish', p),
    mqttDisableTopic: (p: { connectionId: string; topic: string }) => invoke('mqtt:disableTopic', p),
    mqttEnableTopic: (p: { connectionId: string; topic: string }) => invoke('mqtt:enableTopic', p),
    mqttSetPriorityTopic: (p: { connectionId: string; topic: string | null }) => invoke('mqtt:setPriorityTopic', p),
    mqttReadRecent: (p: { connectionId: string; limit?: number }) =>
        invoke<HistoryMessage[]>('mqtt:readRecent', p),
    mqttClearLogs: (connectionId?: string | null) =>
        invoke<{ deletedFiles: number }>('mqtt:clearLogs', connectionId),

    historyQuery: (opts: HistoryQueryOptions) => invoke<HistoryMessage[]>('history:query', opts),

    configRead: () => invoke<ConnectionsFile>('config:read'),
    configWrite: (data: ConnectionsFile) => invoke('config:write', data),

    settingsGet: () => invoke<AppSettings>('settings:get'),
    settingsSet: (s: AppSettings) => invoke<{ needRestart: boolean }>('settings:set', s),
    settingsGetDefaultLogDir: () => invoke<string>('settings:getDefaultLogDir'),
    settingsGetCurrentLogDir: () => invoke<string>('settings:getCurrentLogDir'),
    settingsChooseLogDir: () => invoke<{ path: string } | null>('settings:chooseLogDir'),
    settingsOpenLogDir: (p?: string) => invoke('settings:openLogDir', p),

    appRelaunch: () => invoke('app:relaunch'),
    appGetStartTime: () => invoke<number>('app:getStartTime'),

    onMqttMessages: (cb: (batch: MqttMessage[]) => void) => {
        const listener = (_e: IpcRendererEvent, batch: MqttMessage[]) => cb(batch);
        ipcRenderer.on('mqtt:messages', listener);
        return () => ipcRenderer.removeListener('mqtt:messages', listener);
    },
    onMqttState: (cb: (p: { connectionId: string; state: string; message?: string }) => void) => {
        const listener = (_e: IpcRendererEvent, p: { connectionId: string; state: string; message?: string }) => cb(p);
        ipcRenderer.on('mqtt:state', listener);
        return () => ipcRenderer.removeListener('mqtt:state', listener);
    },
    onAutoDeleteDone: (cb: (files: number) => void) => {
        const listener = (_e: IpcRendererEvent, files: number) => cb(files);
        ipcRenderer.on('app:autoDeleteDone', listener);
        return () => ipcRenderer.removeListener('app:autoDeleteDone', listener);
    },
    onWindowFocused: (cb: () => void) => {
        const listener = () => cb();
        ipcRenderer.on('window:focused', listener);
        return () => ipcRenderer.removeListener('window:focused', listener);
    }
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
