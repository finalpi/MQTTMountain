import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import { initIpc } from './ipc';
import { clearLogsWithoutConnections, initStorage, shutdownStorage } from './storage';
import { initSettings, getCurrentLogDir, readConnections, readSettings } from './settings';
import { MqttService } from './mqtt-service';
import { runAutoDeleteAsync } from './storage';
import { pluginManager } from './plugin-manager';
import './constants';

export { APP_START_TIME } from './constants';

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const RENDERER_DIST = path.join(process.env.APP_ROOT!, 'dist');

function resolveIconPath(): string {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'icon.png')
        : path.join(process.env.APP_ROOT!, 'build', 'icon.png');
}

let win: BrowserWindow | null = null;
let mqttService: MqttService | null = null;

function focusExistingWindow(): void {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    win.webContents.focus();
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

    win.on('closed', () => {
        mqttService?.shutdown();
        win = null;
    });
}

app.on('second-instance', () => {
    focusExistingWindow();
});

app.whenReady().then(async () => {
    initSettings();
    initStorage(getCurrentLogDir());
    clearLogsWithoutConnections(readConnections().connections.map((c) => c.id));
    await pluginManager.init().catch((e) => console.error('[plugin] init:', e));
    mqttService = new MqttService(() => win);
    initIpc(mqttService);
    await createWindow();

    const s = readSettings();
    if (s.autoDeleteDays > 0) {
        runAutoDeleteAsync(s.autoDeleteDays, (files) => {
            if (win && !win.isDestroyed()) win.webContents.send('app:autoDeleteDone', files);
        });
    }
});

app.on('before-quit', () => {
    mqttService?.flush();
    shutdownStorage();
});

app.on('window-all-closed', () => {
    mqttService?.shutdown();
    shutdownStorage();
    pluginManager.shutdown();
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else focusExistingWindow();
});

export { win };
