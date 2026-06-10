import { ipcMain, dialog, shell, app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { MqttService } from './mqtt-service';
import type {
    AppSettings,
    ConnectionsFile,
    ConnectPayload,
    LogDirChangeInfo,
    LogDirDataResult,
    HistoryExportRequest,
    HistoryQueryOptions,
    PublishPayload
} from '../../shared/types';
import {
    readSettings,
    writeSettings,
    readConnections,
    writeConnections,
    getCurrentLogDir,
    getDefaultLogDir
} from './settings';
import {
    clearLogs,
    clearLogsWithoutConnections,
    closeAllLogDbs,
    readRecentByConnection
} from './storage';
import { APP_START_TIME } from './constants';
import { pluginManager } from './plugin-manager';
import { appendPublishHistory, readPublishHistory } from './publish-history';
import { rescheduleAutoDelete } from './auto-delete-scheduler';
import { checkForUpdates, openReleasesPage } from './update-service';
import { exportHistoryToFile } from './history-export';
import { buildHistoryIndex, readHistoryIndexStatus } from './history-index';
import { queryHistoryAsync } from './history-query';

function win(): BrowserWindow | null {
    return BrowserWindow.getAllWindows()[0] ?? null;
}

function normalizeDirForCompare(dir: string): string {
    return path.resolve(dir).replace(/[\\/]+$/u, '').toLowerCase();
}

function resolveRequestedLogDir(logDir: string): string {
    const trimmed = typeof logDir === 'string' ? logDir.trim() : '';
    return trimmed || getDefaultLogDir();
}

function countLogDbFiles(root: string): number {
    if (!fs.existsSync(root)) return 0;
    let total = 0;
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop()!;
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            const fp = path.join(dir, item.name);
            if (item.isDirectory()) stack.push(fp);
            else if (/^\d{4}-\d{2}-\d{2}\.db(?:-wal|-shm)?$/u.test(item.name)) total++;
        }
    }
    return total;
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

function migrateLogDirData(sourceDir: string, targetDir: string): LogDirDataResult {
    assertCurrentLogDir(sourceDir);
    assertDifferentLogDirs(sourceDir, targetDir);
    closeAllLogDbs();
    const files = countLogDbFiles(sourceDir);
    if (files > 0) {
        fs.mkdirSync(targetDir, { recursive: true });
        fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });
        fs.rmSync(sourceDir, { recursive: true, force: true });
    }
    return { files, sourceDir, targetDir };
}

function deleteLogDirData(sourceDir: string): LogDirDataResult {
    assertCurrentLogDir(sourceDir);
    closeAllLogDbs();
    const files = countLogDbFiles(sourceDir);
    if (files > 0 && fs.existsSync(sourceDir)) {
        fs.rmSync(sourceDir, { recursive: true, force: true });
    }
    return { files, sourceDir };
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
    ipcMain.handle('mqtt:readRecent', (_e, p: { connectionId: string; limit?: number }) => {
        try {
            return { success: true, data: readRecentByConnection(p.connectionId, p.limit ?? 5000) };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });
    ipcMain.handle('mqtt:clearLogs', (_e, connectionId?: string | null) => {
        try {
            const r = clearLogs(connectionId ?? null);
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
    ipcMain.handle('history:indexStatus', (_e, req?: { connectionId?: string | null }) => {
        try {
            return { success: true, data: readHistoryIndexStatus(req || {}) };
        } catch (e) {
            return { success: false, message: (e as Error).message };
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
    ipcMain.handle('config:write', (_e, data: ConnectionsFile) => {
        try {
            const prev = readConnections();
            writeConnections(data);
            const prevIds = new Set((prev.connections ?? []).map((c) => c.id));
            const nextIds = new Set((data.connections ?? []).map((c) => c.id));
            const hasRemovedConnection = [...prevIds].some((id) => !nextIds.has(id));
            const cleanup = hasRemovedConnection
                ? clearLogsWithoutConnections((data.connections ?? []).map((c) => c.id))
                : { deletedFiles: 0, deletedDirs: 0 };
            return { success: true, data: cleanup };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });

    // settings
    ipcMain.handle('settings:get', () => ({ success: true, data: readSettings() }));
    ipcMain.handle('settings:set', (_e, s: AppSettings) => {
        try {
            const r = writeSettings(s);
            rescheduleAutoDelete(true);
            return { success: true, data: r };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });
    ipcMain.handle('settings:getLogDirChangeInfo', (_e, logDir: string) => {
        try {
            return { success: true, data: getLogDirChangeInfo(logDir) };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });
    ipcMain.handle('settings:migrateLogDirData', (_e, p: { sourceDir: string; targetDir: string }) => {
        try {
            return { success: true, data: migrateLogDirData(p.sourceDir, p.targetDir) };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });
    ipcMain.handle('settings:deleteLogDirData', (_e, p: { sourceDir: string }) => {
        try {
            return { success: true, data: deleteLogDirData(p.sourceDir) };
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
            return { success: true, data: { path: r.filePaths[0] } };
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
        app.exit(0);
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
