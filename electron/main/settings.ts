import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AppSettings, ConnectionsFile } from '../../shared/types';

const CONFIG_DB_PATH = path.join(app.getPath('userData'), 'mqtt_mountain.db');
const DEFAULT_LOG_ROOT = path.join(app.getPath('userData'), 'message_logs');

const DEFAULT_SETTINGS: AppSettings = {
    autoDeleteDays: 0,
    maxMemoryMessages: 2000,
    maxPerTopic: 500,
    logDir: ''
};

let configDb: Database.Database | null = null;
let currentLogDir = DEFAULT_LOG_ROOT;

function getDb(): Database.Database {
    if (!configDb) {
        fs.mkdirSync(path.dirname(CONFIG_DB_PATH), { recursive: true });
        configDb = new Database(CONFIG_DB_PATH);
        configDb.exec(`
            CREATE TABLE IF NOT EXISTS app_config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);
        try {
            configDb.pragma('journal_mode = WAL');
            configDb.pragma('synchronous = NORMAL');
        } catch (e) {
            console.warn('[settings] pragma:', (e as Error).message);
        }
    }
    return configDb;
}

export function initSettings(): void {
    const s = readSettings();
    if (s.logDir && s.logDir.trim()) {
        try {
            fs.mkdirSync(s.logDir, { recursive: true });
            currentLogDir = s.logDir;
        } catch (e) {
            console.error('[settings] custom logDir unusable, fallback default:', (e as Error).message);
            currentLogDir = DEFAULT_LOG_ROOT;
        }
    } else {
        currentLogDir = DEFAULT_LOG_ROOT;
    }
    fs.mkdirSync(currentLogDir, { recursive: true });
}

export function getCurrentLogDir(): string {
    return currentLogDir;
}
export function getDefaultLogDir(): string {
    return DEFAULT_LOG_ROOT;
}

export function readSettings(): AppSettings {
    try {
        const row = getDb().prepare('SELECT value FROM app_config WHERE key = ?').get('settings') as { value: string } | undefined;
        if (!row) return { ...DEFAULT_SETTINGS };
        const raw = JSON.parse(row.value) as Partial<AppSettings>;
        return {
            autoDeleteDays: Math.max(0, parseInt(String(raw.autoDeleteDays ?? 0), 10) || 0),
            maxMemoryMessages: Math.max(100, parseInt(String(raw.maxMemoryMessages ?? DEFAULT_SETTINGS.maxMemoryMessages), 10) || DEFAULT_SETTINGS.maxMemoryMessages),
            maxPerTopic: Math.max(50, parseInt(String(raw.maxPerTopic ?? DEFAULT_SETTINGS.maxPerTopic), 10) || DEFAULT_SETTINGS.maxPerTopic),
            logDir: typeof raw.logDir === 'string' ? raw.logDir : ''
        };
    } catch (e) {
        console.error('[settings] read:', e);
        return { ...DEFAULT_SETTINGS };
    }
}

export function writeSettings(s: AppSettings): { needRestart: boolean } {
    const prev = readSettings();
    const value = JSON.stringify({
        autoDeleteDays: Math.max(0, parseInt(String(s.autoDeleteDays), 10) || 0),
        maxMemoryMessages: Math.max(100, parseInt(String(s.maxMemoryMessages), 10) || DEFAULT_SETTINGS.maxMemoryMessages),
        maxPerTopic: Math.max(50, parseInt(String(s.maxPerTopic), 10) || DEFAULT_SETTINGS.maxPerTopic),
        logDir: typeof s.logDir === 'string' ? s.logDir.trim() : ''
    });
    getDb().prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)').run('settings', value);
    const newDir = typeof s.logDir === 'string' ? s.logDir.trim() : '';
    const prevDir = prev.logDir.trim();
    return { needRestart: newDir !== prevDir };
}

export function readConnections(): ConnectionsFile {
    try {
        const row = getDb().prepare('SELECT value FROM app_config WHERE key = ?').get('connections') as { value: string } | undefined;
        if (!row) return { connections: [], selectedId: null };
        const data = JSON.parse(row.value) as ConnectionsFile;
        return {
            connections: Array.isArray(data.connections) ? data.connections : [],
            selectedId: data.selectedId ?? null
        };
    } catch (e) {
        console.error('[settings] readConnections:', e);
        return { connections: [], selectedId: null };
    }
}

export function writeConnections(data: ConnectionsFile): void {
    const value = JSON.stringify({
        connections: data.connections || [],
        selectedId: data.selectedId ?? null
    });
    getDb().prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)').run('connections', value);
}

export function closeSettingsDb(): void {
    try {
        configDb?.close();
    } catch {}
    configDb = null;
}
