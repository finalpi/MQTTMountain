import { ipcMain, dialog, shell, app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { MqttService } from './mqtt-service';
import type {
    AppSettings,
    ConnectionsFile,
    ConnectPayload,
    LogDirChangeInfo,
    LogDirDataResult,
    HistoryExportRequest,
    HistoryQueryOptions,
    HistoryQueryStreamCancelRequest,
    HistoryQueryStreamStartRequest,
    PublishPayload
} from '../../shared/types';
import {
    readSettings,
    writeSettings,
    readConnections,
    writeConnections,
    getCurrentLogDir,
    getDefaultLogDir,
    setCurrentLogDir
} from './settings';
import {
    clearLogsAsync,
    clearLogsWithoutConnectionsAsync,
    closeAllLogDbsAsync,
    pauseStorageWrites,
    resumeStorageWrites,
    switchStorageLogRootAsync
} from './storage';
import { APP_START_TIME } from './constants';
import { pluginManager } from './plugin-manager';
import { appendPublishHistory, readPublishHistory } from './publish-history';
import { rescheduleAutoDelete } from './auto-delete-scheduler';
import { checkForUpdates, openReleasesPage } from './update-service';
import { exportHistoryToFile } from './history-export';
import { buildHistoryIndex, readHistoryIndexStatus } from './history-index';
import { cancelHistoryQueryStream, queryHistoryAsync, startHistoryQueryStream } from './history-query';
import { scheduleHeavyJob } from './heavy-job-scheduler';
import { ensureOwnedLogRoot, listOwnedHistoryFiles, resolveLogRootSelection } from './log-root-safety';
import { writeDiagnosticLog } from './diagnostics';

interface LogDirWorkerResult {
    files: number;
    bytes: number;
    sourceDir: string;
    targetDir?: string;
}

interface PendingLogDirChange {
    info: LogDirChangeInfo;
}

const pendingLogDirChanges = new Map<number, PendingLogDirChange>();

async function runLogDirWorker(operation: 'copy' | 'delete', sourceDir: string, targetDir?: string): Promise<LogDirWorkerResult> {
    const workerPath = path.join(__dirname, 'log-dir-worker.js');
    const worker = new Worker(workerPath, { workerData: { operation, sourceDir, targetDir } });
    try {
        return await new Promise<LogDirWorkerResult>((resolve, reject) => {
            let settled = false;
            worker.once('message', (message: { ok?: boolean; result?: LogDirWorkerResult; error?: string }) => {
                settled = true;
                if (message.ok && message.result) resolve(message.result);
                else reject(new Error(message.error || '日志目录操作失败'));
            });
            worker.once('error', (error) => {
                settled = true;
                reject(error);
            });
            worker.once('exit', (code) => {
                if (!settled) reject(new Error(`日志目录任务退出但未返回结果（${code}）`));
            });
        });
    } finally {
        await worker.terminate().catch(() => undefined);
    }
}

function persistedLogDir(root: string): string {
    return normalizeDirForCompare(root) === normalizeDirForCompare(getDefaultLogDir()) ? '' : root;
}

async function switchLogRootAndWriteSettings(settings: AppSettings, targetDir: string, alreadyPaused = false): Promise<void> {
    const previous = readSettings();
    const previousRoot = getCurrentLogDir();
    const targetRoot = ensureOwnedLogRoot(targetDir);
    const changed = normalizeDirForCompare(previousRoot) !== normalizeDirForCompare(targetRoot);
    if (changed && !alreadyPaused) pauseStorageWrites('settings-log-dir-switch');
    try {
        if (changed) {
            await switchStorageLogRootAsync(targetRoot);
            setCurrentLogDir(targetRoot);
        }
        writeSettings({ ...settings, logDir: persistedLogDir(targetRoot) });
    } catch (error) {
        if (changed) {
            try {
                await switchStorageLogRootAsync(previousRoot);
                setCurrentLogDir(previousRoot);
                writeSettings(previous);
            } catch (rollbackError) {
                console.error('[settings] log directory rollback failed:', rollbackError);
            }
        }
        throw error;
    } finally {
        if (changed && !alreadyPaused) resumeStorageWrites('settings-log-dir-switch');
    }
}

function win(): BrowserWindow | null {
    return BrowserWindow.getAllWindows()[0] ?? null;
}

function normalizeDirForCompare(dir: string): string {
    return path.resolve(dir).replace(/[\\/]+$/u, '').toLowerCase();
}

function resolveRequestedLogDir(logDir: string): string {
    return resolveLogRootSelection(typeof logDir === 'string' ? logDir : '', getDefaultLogDir());
}

function countLogDbFiles(root: string): number {
    return listOwnedHistoryFiles(root).length;
}

function getLogDirChangeInfo(logDir: string): LogDirChangeInfo {
    const sourceDir = getCurrentLogDir();
    const targetDir = resolveRequestedLogDir(logDir);
    const changed = normalizeDirForCompare(sourceDir) !== normalizeDirForCompare(targetDir);
    return {
        changed,
        sourceDir,
        targetDir,
        sourceFiles: changed ? countLogDbFiles(sourceDir) : 0
    };
}

function isSubPath(parentDir: string, childDir: string): boolean {
    const parent = normalizeDirForCompare(parentDir);
    const child = normalizeDirForCompare(childDir);
    return child.startsWith(`${parent}${path.sep}`);
}

function assertCurrentLogDir(sourceDir: string): void {
    if (normalizeDirForCompare(sourceDir) !== normalizeDirForCompare(getCurrentLogDir())) {
        throw new Error('源目录不是当前日志目录');
    }
}

function assertDifferentLogDirs(sourceDir: string, targetDir?: string): void {
    if (!targetDir) return;
    if (normalizeDirForCompare(sourceDir) === normalizeDirForCompare(targetDir)) {
        throw new Error('源目录和目标目录相同');
    }
    if (isSubPath(sourceDir, targetDir) || isSubPath(targetDir, sourceDir)) {
        throw new Error('源目录和目标目录不能互为父子目录');
    }
}

async function migrateLogDirData(sourceDir: string, targetDir: string, requestedSettings: AppSettings): Promise<LogDirDataResult> {
    assertCurrentLogDir(sourceDir);
    assertDifferentLogDirs(sourceDir, targetDir);
    pauseStorageWrites('migrate-log-dir');
    try {
        await closeAllLogDbsAsync();
        writeDiagnosticLog('[storage] log directory migration started', { sourceDir, targetDir });
        const result = await runLogDirWorker('copy', sourceDir, targetDir);
        await switchLogRootAndWriteSettings(requestedSettings, targetDir, true);
        try {
            await runLogDirWorker('delete', sourceDir);
        } catch (cleanupError) {
            writeDiagnosticLog('[storage] source cleanup after migration failed; source copy preserved', { sourceDir, targetDir }, cleanupError);
            console.warn('[storage] source cleanup after migration failed; source copy preserved:', cleanupError);
        }
        writeDiagnosticLog('[storage] log directory migration completed', result);
        return { files: result.files, sourceDir, targetDir };
    } finally {
        resumeStorageWrites('migrate-log-dir');
    }
}

async function deleteLogDirData(sourceDir: string, targetDir: string, requestedSettings: AppSettings): Promise<LogDirDataResult> {
    assertCurrentLogDir(sourceDir);
    assertDifferentLogDirs(sourceDir, targetDir);
    pauseStorageWrites('delete-log-dir');
    try {
        await closeAllLogDbsAsync();
        writeDiagnosticLog('[storage] owned log data deletion started', { sourceDir, targetDir });
        const files = countLogDbFiles(sourceDir);
        ensureOwnedLogRoot(targetDir);
        await switchLogRootAndWriteSettings(requestedSettings, targetDir, true);
        try {
            await runLogDirWorker('delete', sourceDir);
        } catch (cleanupError) {
            writeDiagnosticLog('[storage] source cleanup after log directory switch failed; source data preserved', { sourceDir, targetDir }, cleanupError);
            console.warn('[storage] source cleanup after log directory switch failed; source data preserved:', cleanupError);
        }
        writeDiagnosticLog('[storage] owned log data deletion completed', { files, sourceDir, targetDir });
        return { files, sourceDir, targetDir };
    } finally {
        resumeStorageWrites('delete-log-dir');
    }
}

export function initIpc(mqttService: MqttService): void {
    // mqtt
    ipcMain.handle('mqtt:connect', (_e, p: ConnectPayload) => mqttService.connect(p));
    ipcMain.handle('mqtt:disconnect', (_e, id: string) => mqttService.disconnect(id));
    ipcMain.handle('mqtt:subscribe', (_e, p: { connectionId: string; topic: string; qos: 0 | 1 | 2 }) =>
        mqttService.subscribe(p.connectionId, p.topic, p.qos)
    );
    ipcMain.handle('mqtt:unsubscribe', (_e, p: { connectionId: string; topic: string }) =>
        mqttService.unsubscribe(p.connectionId, p.topic)
    );
    ipcMain.handle('mqtt:publish', (_e, p: { connectionId: string } & PublishPayload) =>
        mqttService.publish(p.connectionId, p)
    );
    ipcMain.handle('mqtt:disableTopic', (_e, p: { connectionId: string; topic: string }) => {
        mqttService.disableTopic(p.connectionId, p.topic);
        return { success: true };
    });
    ipcMain.handle('mqtt:enableTopic', (_e, p: { connectionId: string; topic: string }) => {
        mqttService.enableTopic(p.connectionId, p.topic);
        return { success: true };
    });
    ipcMain.handle('mqtt:setPriorityTopic', (_e, p: { connectionId: string; topic: string | null }) => {
        mqttService.setPriorityTopic(p.connectionId, p.topic);
        return { success: true };
    });
    ipcMain.handle('mqtt:setActiveConnection', (_e, p: { connectionId: string | null }) => {
        mqttService.setActiveConnection(p.connectionId);
        return { success: true };
    });
    ipcMain.handle('mqtt:setDisplayPaused', (_e, p: { connectionId: string; paused: boolean }) => {
        mqttService.setDisplayPaused(p.connectionId, p.paused);
        return { success: true };
    });
    ipcMain.handle('mqtt:readRecent', async (_e, p: { connectionId: string; limit?: number }) => {
        try {
            const throughTime = mqttService.hydrationBoundaryTime();
            const limit = Math.min(100_000, Math.max(1, Math.trunc(Number(p.limit) || 5000)));
            const rows = await queryHistoryAsync({
                connectionId: p.connectionId,
                endTime: throughTime,
                order: 'desc',
                limit,
                freshness: 'strict'
            });
            return { success: true, data: { rows, throughTime } };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });
    ipcMain.handle('mqtt:clearLogs', async (_e, connectionId?: string | null) => {
        try {
            const r = await scheduleHeavyJob({ kind: 'exclusive', label: 'clear-logs', priority: 40 }, () => clearLogsAsync(connectionId ?? null)).promise;
            return { success: true, data: r };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });

    // history
    ipcMain.handle('history:query', async (_e, opts: HistoryQueryOptions) => {
        try {
            return { success: true, data: await queryHistoryAsync(opts || {}) };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });
    ipcMain.handle('history:queryStreamStart', (event, req: HistoryQueryStreamStartRequest) => {
        try {
            if (!req?.requestId) return { success: false, message: '缺少流式查询 requestId' };
            startHistoryQueryStream(event.sender, req);
            return { success: true, data: { requestId: req.requestId } };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });
    ipcMain.handle('history:queryStreamCancel', (_event, req: HistoryQueryStreamCancelRequest) => {
        try {
            if (!req?.requestId) return { success: false, message: '缺少流式查询 requestId' };
            cancelHistoryQueryStream(req.requestId);
            return { success: true, data: { requestId: req.requestId } };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });
    ipcMain.handle('history:indexStatus', (_e, req?: { connectionId?: string | null }) => {
        const startedAt = performance.now();
        try {
            return { success: true, data: readHistoryIndexStatus(req || {}) };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        } finally {
            const elapsedMs = performance.now() - startedAt;
            if (elapsedMs > 100) writeDiagnosticLog('[main-performance] slow history index status', { elapsedMs: Math.round(elapsedMs) });
        }
    });
    ipcMain.handle('history:buildIndex', async (event, req?: { connectionId?: string | null }) => {
        try {
            return { success: true, data: await buildHistoryIndex(event.sender, req || {}) };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });
    ipcMain.handle('history:export', async (event, req: HistoryExportRequest) => {
        try {
            const defaultName = `history-${Date.now()}.${req.format === 'zip' ? 'zip' : 'json'}`;
            const picked = await dialog.showSaveDialog(win() ?? undefined!, {
                title: req.format === 'zip' ? '导出历史 ZIP' : '导出历史 JSON',
                defaultPath: path.join(app.getPath('downloads'), defaultName),
                filters: req.format === 'zip'
                    ? [{ name: 'ZIP 文件', extensions: ['zip'] }]
                    : [{ name: 'JSON 文件', extensions: ['json'] }]
            });
            if (picked.canceled || !picked.filePath) {
                return { success: false, message: '已取消导出' };
            }
            const result = await exportHistoryToFile(event.sender, req, picked.filePath);
            return { success: true, data: result };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });
    ipcMain.handle('history:openExportDir', async (_e, filePath: string) => {
        try {
            if (!filePath || !filePath.trim()) return { success: false, message: '文件路径为空' };
            shell.showItemInFolder(filePath);
            return { success: true };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });

    // config
    ipcMain.handle('config:read', () => ({ success: true, data: readConnections() }));
    ipcMain.handle('config:write', async (_e, data: ConnectionsFile) => {
        try {
            const prev = readConnections();
            writeConnections(data);
            const prevIds = new Set((prev.connections ?? []).map((c) => c.id));
            const nextIds = new Set((data.connections ?? []).map((c) => c.id));
            const hasRemovedConnection = [...prevIds].some((id) => !nextIds.has(id));
            const cleanup = hasRemovedConnection
                ? await scheduleHeavyJob(
                    { kind: 'exclusive', label: 'clear-stale-logs', priority: 35 },
                    () => clearLogsWithoutConnectionsAsync((data.connections ?? []).map((c) => c.id))
                ).promise
                : { deletedFiles: 0, deletedDirs: 0 };
            return { success: true, data: cleanup };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });

    // settings
    ipcMain.handle('settings:get', () => ({ success: true, data: readSettings() }));
    ipcMain.handle('settings:set', async (event, s: AppSettings) => {
        try {
            const desiredRoot = ensureOwnedLogRoot(resolveRequestedLogDir(s.logDir));
            pendingLogDirChanges.delete(event.sender.id);
            await switchLogRootAndWriteSettings(s, desiredRoot);
            rescheduleAutoDelete(true);
            return { success: true, data: { needRestart: false } };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });
    ipcMain.handle('settings:getLogDirChangeInfo', (event, logDir: string) => {
        const startedAt = performance.now();
        try {
            const info = getLogDirChangeInfo(logDir);
            pendingLogDirChanges.set(event.sender.id, { info });
            return { success: true, data: info };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        } finally {
            const elapsedMs = performance.now() - startedAt;
            if (elapsedMs > 100) writeDiagnosticLog('[main-performance] slow log directory inspection', { elapsedMs: Math.round(elapsedMs) });
        }
    });
    ipcMain.handle('settings:migrateLogDirData', async (event, p: { sourceDir: string; targetDir: string }) => {
        try {
            const pending = pendingLogDirChanges.get(event.sender.id);
            if (!pending
                || normalizeDirForCompare(pending.info.sourceDir) !== normalizeDirForCompare(p.sourceDir)
                || normalizeDirForCompare(pending.info.targetDir) !== normalizeDirForCompare(p.targetDir)) {
                throw new Error('日志目录迁移上下文已失效，请重新保存设置');
            }
            pendingLogDirChanges.delete(event.sender.id);
            const requestedSettings = { ...readSettings(), logDir: persistedLogDir(pending.info.targetDir) };
            const data = await scheduleHeavyJob(
                { kind: 'exclusive', label: 'migrate-log-dir', priority: 40 },
                () => migrateLogDirData(p.sourceDir, p.targetDir, requestedSettings)
            ).promise;
            return { success: true, data };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });
    ipcMain.handle('settings:deleteLogDirData', async (event, p: { sourceDir: string }) => {
        try {
            const pending = pendingLogDirChanges.get(event.sender.id);
            if (!pending || normalizeDirForCompare(pending.info.sourceDir) !== normalizeDirForCompare(p.sourceDir)) {
                throw new Error('日志目录变更上下文已失效，请重新保存设置');
            }
            pendingLogDirChanges.delete(event.sender.id);
            const requestedSettings = { ...readSettings(), logDir: persistedLogDir(pending.info.targetDir) };
            const data = await scheduleHeavyJob(
                { kind: 'exclusive', label: 'delete-log-dir', priority: 40 },
                () => deleteLogDirData(p.sourceDir, pending.info.targetDir, requestedSettings)
            ).promise;
            return { success: true, data };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });

    ipcMain.handle('settings:getDefaultLogDir', () => ({ success: true, data: getDefaultLogDir() }));
    ipcMain.handle('settings:getCurrentLogDir', () => ({ success: true, data: getCurrentLogDir() }));
    ipcMain.handle('settings:chooseLogDir', async () => {
        try {
            const r = await dialog.showOpenDialog(win() ?? undefined!, {
                title: '选择消息日志保存目录',
                properties: ['openDirectory', 'createDirectory'],
                defaultPath: getCurrentLogDir()
            });
            if (r.canceled || !r.filePaths.length) return { success: true, data: null };
            return { success: true, data: { path: resolveLogRootSelection(r.filePaths[0], getDefaultLogDir()) } };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });
    ipcMain.handle('settings:openLogDir', async (_e, p?: string) => {
        try {
            const target = p && p.trim() ? p.trim() : getCurrentLogDir();
            fs.mkdirSync(target, { recursive: true });
            const err = await shell.openPath(target);
            if (err) return { success: false, message: err };
            return { success: true };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });

    // app
    ipcMain.handle('app:relaunch', () => {
        app.relaunch();
        app.quit();
        return { success: true };
    });
    ipcMain.handle('app:getStartTime', () => ({ success: true, data: APP_START_TIME }));
    ipcMain.handle('app:getVersion', () => ({ success: true, data: app.getVersion() }));
    ipcMain.handle('app:checkForUpdates', async () => {
        try {
            return { success: true, data: await checkForUpdates() };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });
    ipcMain.handle('app:openReleasesPage', async (_e, url?: string) => {
        try {
            await openReleasesPage(url);
            return { success: true };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });

    ipcMain.handle('publishHistory:read', (_e, p: { connectionId: string; limit?: number }) => {
        try {
            return { success: true, data: readPublishHistory(p.connectionId, p.limit ?? 50) };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });
    ipcMain.handle('publishHistory:append', (_e, row: {
        connectionId: string;
        topic: string;
        payload: string;
        qos: number;
        retain: boolean;
        time: number;
    }) => {
        try {
            appendPublishHistory(row);
            return { success: true };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });

    // ----------------- plugins -----------------
    ipcMain.handle('plugin:list', () => {
        try { return { success: true, data: pluginManager.list() }; }
        catch (e) { return { success: false, message: (e as Error).message }; }
    });
    ipcMain.handle('plugin:setEnabled', async (_e, p: { pluginId: string; enabled: boolean }) => {
        try { await pluginManager.setEnabled(p.pluginId, p.enabled); return { success: true }; }
        catch (e) { return { success: false, message: (e as Error).message }; }
    });
    ipcMain.handle('plugin:installFromGit', async (_e, p: { url: string; ref?: string }) => {
        try { const r = await pluginManager.installFromGit(p.url, p.ref); return { success: true, data: r }; }
        catch (e) { return { success: false, message: (e as Error).message }; }
    });
    ipcMain.handle('plugin:installFromPath', async (_e, localPath: string) => {
        try { const r = await pluginManager.installFromPath(localPath); return { success: true, data: r }; }
        catch (e) { return { success: false, message: (e as Error).message }; }
    });
    ipcMain.handle('plugin:uninstall', async (_e, pluginId: string) => {
        try { await pluginManager.uninstall(pluginId); return { success: true }; }
        catch (e) { return { success: false, message: (e as Error).message }; }
    });
    ipcMain.handle('plugin:reload', async (_e, pluginId: string) => {
        try { await pluginManager.reload(pluginId); return { success: true }; }
        catch (e) { return { success: false, message: (e as Error).message }; }
    });
    ipcMain.handle('plugin:updateFromGit', async (_e, pluginId: string) => {
        try { await pluginManager.updateFromGit(pluginId); return { success: true }; }
        catch (e) { return { success: false, message: (e as Error).message }; }
    });
    ipcMain.handle('plugin:checkUpdates', async () => {
        try { return { success: true, data: await pluginManager.checkUpdates() }; }
        catch (e) { return { success: false, message: (e as Error).message }; }
    });
    ipcMain.handle('plugin:decode', async (_e, p: { topic: string; payload: string }) => {
        try { return { success: true, data: await pluginManager.decode(p.topic, p.payload) }; }
        catch (e) { return { success: false, message: (e as Error).message }; }
    });
    ipcMain.handle('plugin:decodeBatch', async (_e, items: { topic: string; payload: string }[]) => {
        try { return { success: true, data: await pluginManager.decodeBatch(items) }; }
        catch (e) { return { success: false, message: (e as Error).message }; }
    });
    ipcMain.handle('plugin:topicLabels', async (_e, topics: string[]) => {
        try { return { success: true, data: await pluginManager.topicLabels(topics) }; }
        catch (e) { return { success: false, message: (e as Error).message }; }
    });
    ipcMain.handle('plugin:senderParamAction', async (_e, p: {
        pluginId: string;
        senderId: string;
        paramKey: string;
        actionId: string;
        params: Record<string, string>;
    }) => {
        try {
            return {
                success: true,
                data: await pluginManager.senderParamAction(p.pluginId, {
                    senderId: p.senderId,
                    paramKey: p.paramKey,
                    actionId: p.actionId,
                    params: p.params
                })
            };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });
    ipcMain.handle('plugin:openDir', async () => {
        try { await shell.openPath(pluginManager.pluginsDir); return { success: true }; }
        catch (e) { return { success: false, message: (e as Error).message }; }
    });
    ipcMain.handle('plugin:pluginsDir', () => ({ success: true, data: pluginManager.pluginsDir }));
    ipcMain.handle('plugin:chooseLocalDir', async () => {
        try {
            const r = await dialog.showOpenDialog(win() ?? undefined!, {
                title: '选择本地插件目录',
                properties: ['openDirectory']
            });
            if (r.canceled || !r.filePaths.length) return { success: true, data: null };
            return { success: true, data: { path: r.filePaths[0] } };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });
    ipcMain.handle('plugin:readViewHtml', async (_e, p: { pluginId: string; viewId: string }) => {
        try {
            return { success: true, data: pluginManager.readViewHtml(p.pluginId, p.viewId) };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });
}
