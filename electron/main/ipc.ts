import { ipcMain, dialog, shell, app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { MqttService } from './mqtt-service';
import type {
    AppSettings,
    ConnectionsFile,
    ConnectPayload,
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
    queryHistory,
    readRecentByConnection,
    runAutoDeleteAsync
} from './storage';
import { APP_START_TIME } from './constants';

function win(): BrowserWindow | null {
    return BrowserWindow.getAllWindows()[0] ?? null;
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
    ipcMain.handle('history:query', (_e, opts: HistoryQueryOptions) => {
        try {
            return { success: true, data: queryHistory(opts || {}) };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });

    // config
    ipcMain.handle('config:read', () => ({ success: true, data: readConnections() }));
    ipcMain.handle('config:write', (_e, data: ConnectionsFile) => {
        try {
            writeConnections(data);
            return { success: true };
        } catch (e) {
            return { success: false, message: (e as Error).message };
        }
    });

    // settings
    ipcMain.handle('settings:get', () => ({ success: true, data: readSettings() }));
    ipcMain.handle('settings:set', (_e, s: AppSettings) => {
        try {
            const r = writeSettings(s);
            runAutoDeleteAsync(s.autoDeleteDays, (files) => {
                const w = win();
                if (w && !w.isDestroyed()) w.webContents.send('app:autoDeleteDone', files);
            });
            return { success: true, data: r };
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
}
