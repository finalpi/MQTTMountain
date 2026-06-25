import Database from 'better-sqlite3';

export const HISTORY_INDEX_SCHEMA_VERSION = '3';
export const LEGACY_HISTORY_INDEX_SCHEMA_VERSION = '2';

export function setIndexMeta(db: Database.Database, key: string, value: string | number): void {
    db.prepare(
        `INSERT INTO history_index_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    ).run(key, String(value));
}

export function getIndexMeta(db: Database.Database, key: string): string | null {
    try {
        const row = db.prepare('SELECT value FROM history_index_meta WHERE key = ?').get(key) as { value: string } | undefined;
        return row?.value ?? null;
    } catch {
        return null;
    }
}

export function getHistoryIndexSchemaVersion(db: Database.Database): string | null {
    const version = getIndexMeta(db, 'schema_version');
    return version === HISTORY_INDEX_SCHEMA_VERSION || version === LEGACY_HISTORY_INDEX_SCHEMA_VERSION ? version : null;
}

function historyMessagesColumns(db: Database.Database): Set<string> {
    return new Set(db.prepare('PRAGMA table_info(history_messages)').all()
        .map((col) => String((col as { name?: string }).name ?? ''))
        .filter(Boolean));
}

export function ensureHistoryIndexSchema(db: Database.Database, options: { initializeCompletion?: boolean; rebuild?: boolean } = {}): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS history_index_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        ) WITHOUT ROWID;
    `);
    const version = getIndexMeta(db, 'schema_version');
    const columns = historyMessagesColumns(db);
    const hasTable = columns.size > 0;
    const hasPayloadColumn = columns.has('payload');
    const hasV3Columns = columns.has('payload_offset') && columns.has('payload_len');
    const preserveLegacy = !options.rebuild && version === LEGACY_HISTORY_INDEX_SCHEMA_VERSION && hasTable && !hasPayloadColumn;
    const resetIndex = options.rebuild || hasPayloadColumn || !hasTable || (version !== HISTORY_INDEX_SCHEMA_VERSION && !preserveLegacy) || (version === HISTORY_INDEX_SCHEMA_VERSION && !hasV3Columns);

    if (preserveLegacy) return;
    if (resetIndex) {
        db.exec('DROP TABLE IF EXISTS history_messages;');
    }
    db.exec(`
        CREATE TABLE IF NOT EXISTS history_messages (
            bucket_ts INTEGER NOT NULL,
            topic TEXT NOT NULL,
            msg_index INTEGER NOT NULL,
            time_ms INTEGER NOT NULL,
            search_text TEXT NOT NULL,
            payload_offset INTEGER NOT NULL,
            payload_len INTEGER NOT NULL,
            entry_offset INTEGER NOT NULL,
            entry_len INTEGER NOT NULL,
            PRIMARY KEY (bucket_ts, topic, msg_index)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_history_messages_time ON history_messages(time_ms);
        CREATE INDEX IF NOT EXISTS idx_history_messages_topic_time ON history_messages(topic, time_ms);
        CREATE INDEX IF NOT EXISTS idx_history_messages_time_topic ON history_messages(time_ms, topic);
    `);
    setIndexMeta(db, 'schema_version', HISTORY_INDEX_SCHEMA_VERSION);
    if (options.initializeCompletion) {
        const complete = getIndexMeta(db, 'index_complete');
        if (resetIndex || !complete) {
            const row = db.prepare('SELECT COUNT(*) AS count FROM buckets').get() as { count: number };
            setIndexMeta(db, 'index_complete', row.count > 0 ? '0' : '1');
            setIndexMeta(db, 'indexed_message_count', 0);
            setIndexMeta(db, 'indexed_bucket_count', 0);
        }
    }
}
