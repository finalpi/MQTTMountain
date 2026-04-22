import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initIpc } from './ipc';
import { initStorage, shutdownStorage } from './storage';
import { initSettings, getCurrentLogDir, readSettings } from './settings';
import { MqttService } from './mqtt-service';
import { runAutoDeleteAsync } from './storage';
import './constants';

if (process.platform === 'win32') {
    try {
        require('node:child_process').execSync('cmd /c chcp 65001>nul', { stdio: 'ignore', windowsHide: true });
    } catch {}
}

process.env.APP_ROOT = path.join(__dirname, '../..');
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');

let win: BrowserWindow | null = null;
let mqttService: MqttService | null = null;
export { APP_START_TIME } from './constants';

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

async function createWindow() {
    win = new BrowserWindow({
        width: 1480,
        height: 960,
        minWidth: 1200,
        minHeight: 760,
        title: 'MqttMountain',
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

    win.on('focus', () => {
        if (win && !win.isDestroyed()) {
            win.webContents.focus();
            win.webContents.send('window:focused');
        }
    });

    win.on('closed', () => {
        mqttService?.shutdown();
        win = null;
    });
}

app.whenReady().then(async () => {
    initSettings();
    initStorage(getCurrentLogDir());
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
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

export { win };
