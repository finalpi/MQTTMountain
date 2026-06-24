import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type {
    AppSettings,
    ConnectionsFile,
    LogDirChangeInfo,
    LogDirDataResult,
    ConnectPayload,
    HistoryExportProgress,
    HistoryExportRequest,
    HistoryExportResult,
    HistoryIndexProgress,
    HistoryIndexRequest,
    HistoryIndexResult,
    HistoryIndexStatus,
    HistoryQueryOptions,
    HistoryMessage,
    MqttMessage,
    PublishPayload,
    ApiResult,
    UpdateInfo
} from '../../shared/types';
import type { DecodedResult, PluginRecord, PluginUpdateInfo } from '../../shared/plugin';

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
    mqttSetActiveConnection: (p: { connectionId: string | null }) => invoke('mqtt:setActiveConnection', p),
    mqttSetDisplayPaused: (p: { connectionId: string; paused: boolean }) => invoke('mqtt:setDisplayPaused', p),
    mqttReadRecent: (p: { connectionId: string; limit?: number }) =>
        invoke<HistoryMessage[]>('mqtt:readRecent', p),
    mqttClearLogs: (connectionId?: string | null) =>
        invoke<{ deletedFiles: number }>('mqtt:clearLogs', connectionId),

    historyQuery: (opts: HistoryQueryOptions) => invoke<HistoryMessage[]>('history:query', opts),
    historyExport: (req: HistoryExportRequest) => invoke<HistoryExportResult>('history:export', req),
    historyIndexStatus: (req?: HistoryIndexRequest) => invoke<HistoryIndexStatus>('history:indexStatus', req),
    historyBuildIndex: (req?: HistoryIndexRequest) => invoke<HistoryIndexResult>('history:buildIndex', req),
    historyOpenExportDir: (filePath: string) => invoke('history:openExportDir', filePath),

    configRead: () => invoke<ConnectionsFile>('config:read'),
    configWrite: (data: ConnectionsFile) => invoke('config:write', data),

    settingsGet: () => invoke<AppSettings>('settings:get'),
    settingsSet: (s: AppSettings) => invoke<{ needRestart: boolean }>('settings:set', s),
    settingsGetLogDirChangeInfo: (logDir: string) => invoke<LogDirChangeInfo>('settings:getLogDirChangeInfo', logDir),
    settingsMigrateLogDirData: (p: { sourceDir: string; targetDir: string }) => invoke<LogDirDataResult>('settings:migrateLogDirData', p),
    settingsDeleteLogDirData: (p: { sourceDir: string }) => invoke<LogDirDataResult>('settings:deleteLogDirData', p),
    settingsGetDefaultLogDir: () => invoke<string>('settings:getDefaultLogDir'),
    settingsGetCurrentLogDir: () => invoke<string>('settings:getCurrentLogDir'),
    settingsChooseLogDir: () => invoke<{ path: string } | null>('settings:chooseLogDir'),
    settingsOpenLogDir: (p?: string) => invoke('settings:openLogDir', p),

    appRelaunch: () => invoke('app:relaunch'),
    appGetStartTime: () => invoke<number>('app:getStartTime'),
    appGetVersion: () => invoke<string>('app:getVersion'),
    appCheckForUpdates: () => invoke<UpdateInfo>('app:checkForUpdates'),
    appOpenReleasesPage: (url?: string) => invoke('app:openReleasesPage', url),
    publishHistoryRead: (p: { connectionId: string; limit?: number }) =>
        invoke<Array<{ connectionId: string; topic: string; payload: string; qos: number; retain: boolean; time: number }>>('publishHistory:read', p),
    publishHistoryAppend: (row: { connectionId: string; topic: string; payload: string; qos: number; retain: boolean; time: number }) =>
        invoke('publishHistory:append', row),

    // ---------------- plugins ----------------
    pluginList: () => invoke<PluginRecord[]>('plugin:list'),
    pluginSetEnabled: (p: { pluginId: string; enabled: boolean }) => invoke('plugin:setEnabled', p),
    pluginInstallFromGit: (p: { url: string; ref?: string }) => invoke<PluginRecord>('plugin:installFromGit', p),
    pluginInstallFromPath: (localPath: string) => invoke<PluginRecord>('plugin:installFromPath', localPath),
    pluginUninstall: (pluginId: string) => invoke('plugin:uninstall', pluginId),
    pluginReload: (pluginId: string) => invoke('plugin:reload', pluginId),
    pluginUpdateFromGit: (pluginId: string) => invoke('plugin:updateFromGit', pluginId),
    pluginCheckUpdates: () => invoke<PluginUpdateInfo[]>('plugin:checkUpdates'),
    pluginDecode: (p: { topic: string; payload: string }) => invoke<DecodedResult | null>('plugin:decode', p),
    pluginDecodeBatch: (items: { topic: string; payload: string }[]) =>
        invoke<(DecodedResult | null)[]>('plugin:decodeBatch', items),
    pluginTopicLabels: (topics: string[]) => invoke<Record<string, string>>('plugin:topicLabels', topics),
    pluginSenderParamAction: (p: {
        pluginId: string;
        senderId: string;
        paramKey: string;
        actionId: string;
        params: Record<string, string>;
    }) => invoke<string | number | boolean | Record<string, string | number | boolean>>('plugin:senderParamAction', p),
    pluginOpenDir: () => invoke('plugin:openDir'),
    pluginsDir: () => invoke<string>('plugin:pluginsDir'),
    pluginChooseLocalDir: () => invoke<{ path: string } | null>('plugin:chooseLocalDir'),
    pluginReadViewHtml: (p: { pluginId: string; viewId: string }) =>
        invoke<{ html: string; baseUrl: string }>('plugin:readViewHtml', p),

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
    },
    onHistoryExportProgress: (cb: (p: HistoryExportProgress) => void) => {
        const listener = (_e: IpcRendererEvent, p: HistoryExportProgress) => cb(p);
        ipcRenderer.on('history:exportProgress', listener);
        return () => ipcRenderer.removeListener('history:exportProgress', listener);
    },
    onHistoryIndexProgress: (cb: (p: HistoryIndexProgress) => void) => {
        const listener = (_e: IpcRendererEvent, p: HistoryIndexProgress) => cb(p);
        ipcRenderer.on('history:indexProgress', listener);
        return () => ipcRenderer.removeListener('history:indexProgress', listener);
    }
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
