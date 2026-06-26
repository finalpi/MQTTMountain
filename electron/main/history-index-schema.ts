import Database from 'better-sqlite3';

export const HISTORY_INDEX_SCHEMA_VERSION = '4';
export type HistoryFtsTokenizer = 'trigram' | 'unicode61' | 'none';

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
    return version === HISTORY_INDEX_SCHEMA_VERSION ? version : null;
}

export function getHistoryFtsTokenizer(db: Database.Database): HistoryFtsTokenizer {
    const tokenizer = getIndexMeta(db, 'fts5_tokenizer');
    if (tokenizer === 'trigram' || tokenizer === 'unicode61') return tokenizer;
    return getIndexMeta(db, 'fts5_enabled') === '1' ? 'unicode61' : 'none';
}

export function hasHistoryFts(db: Database.Database): boolean {
    return getHistoryFtsTokenizer(db) !== 'none';
}

function historyMessagesColumns(db: Database.Database): Set<string> {
    return new Set(db.prepare('PRAGMA table_info(history_messages)').all()
        .map((col) => String((col as { name?: string }).name ?? ''))
        .filter(Boolean));
}

function tableExists(db: Database.Database, name: string): boolean {
    const row = db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(name);
    return Boolean(row);
}

function probeFtsTokenizer(db: Database.Database, tokenizer: Exclude<HistoryFtsTokenizer, 'none'>): boolean {
    try {
        db.exec(`CREATE VIRTUAL TABLE temp.__fts_probe_${tokenizer} USING fts5(x, tokenize='${tokenizer}'); DROP TABLE temp.__fts_probe_${tokenizer};`);
        return true;
    } catch {
        return false;
    }
}

export function detectHistoryFtsTokenizer(db: Database.Database): HistoryFtsTokenizer {
    if (probeFtsTokenizer(db, 'trigram')) return 'trigram';
    if (probeFtsTokenizer(db, 'unicode61')) return 'unicode61';
    return 'none';
}

function createHistoryFtsTable(db: Database.Database, tokenizer: Exclude<HistoryFtsTokenizer, 'none'>): void {
    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS history_messages_fts USING fts5(
            search_text,
            bucket_ts UNINDEXED,
            topic UNINDEXED,
            msg_index UNINDEXED,
            time_ms UNINDEXED,
            tokenize='${tokenizer}'
        );
    `);
}

export function ensureHistoryIndexSchema(db: Database.Database, options: { initializeCompletion?: boolean; rebuild?: boolean } = {}): HistoryFtsTokenizer {
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
    const hasV4Columns = columns.has('payload_offset') && columns.has('payload_len') && columns.has('entry_offset') && columns.has('entry_len');
    const resetIndex = options.rebuild || hasPayloadColumn || !hasTable || version !== HISTORY_INDEX_SCHEMA_VERSION || !hasV4Columns;

    if (resetIndex) {
        db.exec('DROP TABLE IF EXISTS history_messages_fts; DROP TABLE IF EXISTS history_messages;');
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

    let tokenizer = detectHistoryFtsTokenizer(db);
    if (tokenizer !== 'none') {
        try {
            createHistoryFtsTable(db, tokenizer);
        } catch {
            tokenizer = 'none';
            db.exec('DROP TABLE IF EXISTS history_messages_fts;');
        }
    } else if (tableExists(db, 'history_messages_fts')) {
        db.exec('DROP TABLE IF EXISTS history_messages_fts;');
    }

    setIndexMeta(db, 'schema_version', HISTORY_INDEX_SCHEMA_VERSION);
    setIndexMeta(db, 'fts5_enabled', tokenizer === 'none' ? '0' : '1');
    setIndexMeta(db, 'fts5_tokenizer', tokenizer);
    if (options.initializeCompletion) {
        const complete = getIndexMeta(db, 'index_complete');
        if (resetIndex || !complete) {
            const row = db.prepare('SELECT COUNT(*) AS count FROM buckets').get() as { count: number };
            setIndexMeta(db, 'index_complete', row.count > 0 ? '0' : '1');
            setIndexMeta(db, 'indexed_message_count', 0);
            setIndexMeta(db, 'indexed_bucket_count', 0);
        }
    }
    return tokenizer;
}
