import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import { initIpc } from './ipc';
import { scheduleHeavyJob } from './heavy-job-scheduler';
import {
    clearLogsWithoutConnectionsAsync,
    initStorage,
    purgeNonCurrentHistoryIndexDbsAsync,
    shutdownStorageAsync,
    stopAcceptingStorageWrites,
    stopAutoDeleteWorkers
} from './storage';
import { initSettings, getCurrentLogDir, readConnections } from './settings';
import { MqttService } from './mqtt-service';
import { writeDiagnosticLog } from './diagnostics';
import { startAutoDeleteScheduler, stopAutoDeleteScheduler } from './auto-delete-scheduler';
import { pluginManager } from './plugin-manager';
import './constants';
import type { StartupMaintenanceDone } from '../../shared/types';

export { APP_START_TIME } from './constants';

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const RENDERER_DIST = path.join(process.env.APP_ROOT!, 'dist');
const STARTUP_MAINTENANCE_DELAY_MS = 5_000;
const STORAGE_SHUTDOWN_TIMEOUT_MS = 120_000;
function installDiagnosticHandlers(): void {
    process.on('uncaughtException', (error) => {
        writeDiagnosticLog('[process] uncaughtException', error);
        console.error('[process] uncaughtException:', error);
    });
    process.on('unhandledRejection', (reason) => {
        writeDiagnosticLog('[process] unhandledRejection', reason);
        console.error('[process] unhandledRejection:', reason);
    });
    process.on('warning', (warning) => {
        writeDiagnosticLog('[process] warning', warning);
    });
    app.on('render-process-gone', (_event, webContents, details) => {
        writeDiagnosticLog('[electron] render-process-gone', { webContentsId: webContents.id, details });
        console.error('[electron] render-process-gone:', details);
        const mainRendererGone = !!win && !win.isDestroyed() && win.webContents.id === webContents.id;
        if (mainRendererGone && details.reason !== 'clean-exit' && !isQuitting) {
            writeDiagnosticLog('[main] quitting after renderer failure', {
                webContentsId: webContents.id,
                reason: details.reason,
                exitCode: details.exitCode
            });
            setImmediate(() => {
                if (!isQuitting) app.quit();
            });
        }
    });
    app.on('child-process-gone', (_event, details) => {
        writeDiagnosticLog('[electron] child-process-gone', details);
        console.error('[electron] child-process-gone:', details);
    });
    app.on('gpu-info-update', () => {
        writeDiagnosticLog('[electron] gpu-info-update');
    });
}

installDiagnosticHandlers();

function resolveIconPath(): string {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'icon.png')
        : path.join(process.env.APP_ROOT!, 'build', 'icon.png');
}

let win: BrowserWindow | null = null;
let mqttService: MqttService | null = null;
let quitAfterStorageShutdown = false;
let quitShutdownPromise: Promise<void> | null = null;
let startupMaintenanceTimer: ReturnType<typeof setTimeout> | null = null;
let isQuitting = false;

function focusExistingWindow(): void {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    win.webContents.focus();
}

function notifyStartupMaintenanceDone(payload: StartupMaintenanceDone): void {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('app:startupMaintenanceDone', payload);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

function scheduleStartupMaintenance(): void {
    if (startupMaintenanceTimer) clearTimeout(startupMaintenanceTimer);
    startupMaintenanceTimer = setTimeout(() => {
        startupMaintenanceTimer = null;
        void runStartupMaintenance();
    }, STARTUP_MAINTENANCE_DELAY_MS);
}

async function purgeOldHistoryBeforeUse(): Promise<void> {
    try {
        const result = await purgeNonCurrentHistoryIndexDbsAsync();
        if (result.deletedFiles > 0) {
            console.info(`[main] deleted ${result.deletedFiles} old history db files before startup; history index schema changed`);
        }
    } catch (error) {
        console.error('[main] pre-window old history purge failed:', error);
    }
}

async function runStartupMaintenance(): Promise<void> {
    await Promise.all([
        scheduleHeavyJob(
            { kind: 'exclusive', label: 'startup-purge-old-history-indexes', priority: 34 },
            () => purgeNonCurrentHistoryIndexDbsAsync()
        ).promise.then(
            (result) => notifyStartupMaintenanceDone({ kind: 'oldHistoryIndexes', success: true, deletedFiles: result.deletedFiles }),
            (error) => {
                console.error('[main] startup old history index purge failed:', error);
                notifyStartupMaintenanceDone({ kind: 'oldHistoryIndexes', success: false, message: (error as Error).message });
            }
        ),
        scheduleHeavyJob(
            { kind: 'exclusive', label: 'startup-clear-stale-logs', priority: 35 },
            () => clearLogsWithoutConnectionsAsync(readConnections().connections.map((c) => c.id))
        ).promise.then(
            (result) => notifyStartupMaintenanceDone({
                kind: 'staleLogs',
                success: true,
                deletedDirs: result.deletedDirs,
                deletedFiles: result.deletedFiles
            }),
            (error) => {
                console.error('[main] startup stale log cleanup failed:', error);
                notifyStartupMaintenanceDone({ kind: 'staleLogs', success: false, message: (error as Error).message });
            }
        )
    ]);
}

function shutdownForQuit(): Promise<void> {
    writeDiagnosticLog('[main] shutdown start');
    isQuitting = true;
    stopAcceptingStorageWrites();
    if (quitShutdownPromise) return quitShutdownPromise;
    quitShutdownPromise = (async () => {
        if (startupMaintenanceTimer) {
            clearTimeout(startupMaintenanceTimer);
            startupMaintenanceTimer = null;
        }
        stopAutoDeleteScheduler();
        await stopAutoDeleteWorkers();
        mqttService?.shutdown();
        await withTimeout(shutdownStorageAsync(), STORAGE_SHUTDOWN_TIMEOUT_MS, 'storage shutdown').catch((error) => {
            console.warn('[main] storage shutdown did not finish cleanly:', error);
        });
        pluginManager.shutdown();
        writeDiagnosticLog('[main] shutdown complete');
    })();
    return quitShutdownPromise;
}

async function createWindow() {
    win = new BrowserWindow({
        width: 1480,
        height: 960,
        minWidth: 1200,
        minHeight: 760,
        title: 'MQTTMountain',
        icon: resolveIconPath(),
        backgroundColor: '#0f172a',
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            spellcheck: false
        }
    });

    try {
        await session.defaultSession.setProxy({ proxyRules: 'direct' });
    } catch (e) {
        console.warn('[main] setProxy failed', e);
    }

    if (VITE_DEV_SERVER_URL) {
        await win.loadURL(VITE_DEV_SERVER_URL);
        win.webContents.openDevTools({ mode: 'detach' });
    } else {
        await win.loadFile(path.join(RENDERER_DIST, 'index.html'));
    }

    win.maximize();

    win.webContents.setBackgroundThrottling(false);

    const notifyFocus = () => {
        if (!win || win.isDestroyed()) return;
        win.webContents.focus();
        win.webContents.send('window:focused');
    };

    win.on('focus', notifyFocus);
    win.on('restore', notifyFocus);
    win.on('show', notifyFocus);
    win.webContents.on('did-finish-load', notifyFocus);

    win.webContents.on('console-message', (_event, _level, message) => {
        if (message.startsWith('[renderer-diagnostics]') || message.startsWith('[plugin-bridge]')) {
            writeDiagnosticLog('[renderer] console', message);
        }
    });

    win.webContents.on('unresponsive', () => {
        writeDiagnosticLog('[window] unresponsive');
        console.error('[window] unresponsive');
    });

    win.webContents.on('responsive', () => {
        writeDiagnosticLog('[window] responsive');
    });

    win.on('close', () => {
        writeDiagnosticLog('[window] close', { isQuitting });
        if (isQuitting) return;
        isQuitting = true;
        stopAcceptingStorageWrites();
        mqttService?.shutdown();
    });

    win.on('closed', () => {
        writeDiagnosticLog('[window] closed');
        win = null;
    });
}

app.on('second-instance', () => {
    focusExistingWindow();
});

app.whenReady().then(async () => {
    writeDiagnosticLog('[main] app ready', {
        version: app.getVersion(),
        packaged: app.isPackaged,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid
    });
    initSettings();
    initStorage(getCurrentLogDir());
    await purgeOldHistoryBeforeUse();
    await pluginManager.init().catch((e) => {
        writeDiagnosticLog('[plugin] init failed', e);
        console.error('[plugin] init:', e);
    });
    mqttService = new MqttService(() => win);
    initIpc(mqttService);
    await createWindow();
    scheduleStartupMaintenance();
    startAutoDeleteScheduler(() => win);
}).catch((error) => {
    writeDiagnosticLog('[main] app ready failed', error);
    console.error('[main] app ready failed:', error);
});

app.on('before-quit', (event) => {
    if (quitAfterStorageShutdown) return;
    event.preventDefault();
    void shutdownForQuit()
        .catch((error) => console.error('[main] shutdown before quit failed:', error))
        .finally(() => {
            quitAfterStorageShutdown = true;
            app.quit();
        });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else focusExistingWindow();
});

export { win };
