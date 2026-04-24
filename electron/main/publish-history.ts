import { app } from 'electron';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface PublishHistoryRow {
    connectionId: string;
    topic: string;
    payload: string;
    qos: number;
    retain: boolean;
    time: number;
}

const DB_PATH = path.join(app.getPath('userData'), 'mqtt_mountain.db');

function openDb(): Database.Database {
    const db = new Database(DB_PATH);
    db.exec(`
        CREATE TABLE IF NOT EXISTS publish_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            connection_id TEXT NOT NULL,
            topic TEXT NOT NULL,
            payload TEXT NOT NULL,
            qos INTEGER NOT NULL,
            retain INTEGER NOT NULL,
            time INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_publish_history_conn_time
        ON publish_history(connection_id, time DESC);
    `);
    return db;
}

export function appendPublishHistory(row: PublishHistoryRow): void {
    const db = openDb();
    try {
        db.prepare(`
            INSERT INTO publish_history (connection_id, topic, payload, qos, retain, time)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            row.connectionId,
            row.topic,
            row.payload,
            row.qos,
            row.retain ? 1 : 0,
            row.time
        );
    } finally {
        db.close();
    }
}

export function readPublishHistory(connectionId: string, limit = 50): PublishHistoryRow[] {
    if (!connectionId) return [];
    const db = openDb();
    try {
        const rows = db.prepare(`
            SELECT connection_id, topic, payload, qos, retain, time
            FROM publish_history
            WHERE connection_id = ?
            ORDER BY time DESC
            LIMIT ?
        `).all(connectionId, Math.max(1, limit)) as Array<{
            connection_id: string;
            topic: string;
            payload: string;
            qos: number;
            retain: number;
            time: number;
        }>;
        return rows.map((row) => ({
            connectionId: row.connection_id,
            topic: row.topic,
            payload: row.payload,
            qos: row.qos,
            retain: !!row.retain,
            time: row.time
        }));
    } finally {
        db.close();
    }
}
