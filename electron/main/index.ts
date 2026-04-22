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

function resolveIconPath(): string {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'icon.png')
        : path.join(process.env.APP_ROOT!, 'build', 'icon.png');
}

let win: BrowserWindow | null = null;
let mqttService: MqttService | null = null;
export { APP_START_TIME } from './constants';

/**
 * 修复 Windows 文本输入偶发失灵（只能删除/粘贴，不能敲键）
 *   1) 关闭 Chromium 的 Native Window Occlusion 计算
 *   2) 关闭后台节流（即使窗口在后台也按正常频率派发事件）
 *   3) 关闭 renderer backgrounding，防止渲染进程被降级
 *   4) 关闭 timer throttling
 */
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,HardwareMediaKeyHandling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

async function createWindow() {
    win = new BrowserWindow({
        width: 1480,
        height: 960,
        minWidth: 1200,
        minHeight: 760,
        title: 'MqttMountain',
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

    // 关闭后台节流，避免渲染进程被 Chromium 降级后 IME 事件丢失
    win.webContents.setBackgroundThrottling(false);

    const notifyFocus = () => {
        if (!win || win.isDestroyed()) return;
        win.webContents.focus();
        win.webContents.send('window:focused');
    };

    // 多个事件都打一次，最大程度让渲染侧感知到焦点变化
    win.on('focus', notifyFocus);
    win.on('restore', notifyFocus);
    win.on('show', notifyFocus);
    win.webContents.on('did-finish-load', notifyFocus);

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
