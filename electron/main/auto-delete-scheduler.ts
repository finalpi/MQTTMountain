import type { BrowserWindow } from 'electron';
import { readSettings } from './settings';
import { runAutoDeleteAsync } from './storage';

const DAILY_CLEANUP_HOUR = 0;
const DAILY_CLEANUP_MINUTE = 10;
const STARTUP_CATCH_UP_DELAY_MS = 5 * 60 * 1000;
const MIN_RESCHEDULE_DELAY_MS = 1_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let windowGetter: (() => BrowserWindow | null) | null = null;

function notifyAutoDeleteDone(files: number): void {
    const win = windowGetter?.();
    if (win && !win.isDestroyed()) win.webContents.send('app:autoDeleteDone', files);
}

function clearSchedule(): void {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
}

function clearStartupTimer(): void {
    if (!startupTimer) return;
    clearTimeout(startupTimer);
    startupTimer = null;
}

function getNextDailyDelay(now = new Date()): number {
    const next = new Date(now);
    next.setHours(DAILY_CLEANUP_HOUR, DAILY_CLEANUP_MINUTE, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return Math.max(MIN_RESCHEDULE_DELAY_MS, next.getTime() - now.getTime());
}

function runOnce(): void {
    const { autoDeleteDays } = readSettings();
    if (autoDeleteDays <= 0 || running) return;

    running = true;
    runAutoDeleteAsync(autoDeleteDays, notifyAutoDeleteDone, () => {
        running = false;
    });
}

function scheduleNextDailyRun(): void {
    clearSchedule();
    const { autoDeleteDays } = readSettings();
    if (autoDeleteDays <= 0) return;

    timer = setTimeout(() => {
        runOnce();
        scheduleNextDailyRun();
    }, getNextDailyDelay());
}

export function startAutoDeleteScheduler(getWindow: () => BrowserWindow | null): void {
    windowGetter = getWindow;
    scheduleNextDailyRun();

    const { autoDeleteDays } = readSettings();
    if (autoDeleteDays > 0) {
        clearStartupTimer();
        startupTimer = setTimeout(() => {
            startupTimer = null;
            runOnce();
        }, STARTUP_CATCH_UP_DELAY_MS);
    }
}

export function rescheduleAutoDelete(immediate = false): void {
    clearStartupTimer();
    scheduleNextDailyRun();
    if (immediate) runOnce();
}

export function stopAutoDeleteScheduler(): void {
    clearSchedule();
    clearStartupTimer();
    windowGetter = null;
}
