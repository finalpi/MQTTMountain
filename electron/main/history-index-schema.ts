import Database from 'better-sqlite3';

export const HISTORY_INDEX_SCHEMA_VERSION = '6';
export const LEGACY_HISTORY_INDEX_SCHEMA_VERSION = '5';
export type HistoryFtsTokenizer = 'trigram' | 'unicode61' | 'none';
export type HistoryFtsLayout = 'contentless' | 'legacy';

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

export function isCompactHistoryIndex(db: Database.Database): boolean {
    return getIndexMeta(db, 'schema_version') === HISTORY_INDEX_SCHEMA_VERSION;
}

export function getHistoryFtsTokenizer(db: Database.Database): HistoryFtsTokenizer {
    const tokenizer = getIndexMeta(db, 'fts5_tokenizer');
    if (tokenizer === 'trigram' || tokenizer === 'unicode61') return tokenizer;
    return getIndexMeta(db, 'fts5_enabled') === '1' ? 'unicode61' : 'none';
}

export function hasHistoryFts(db: Database.Database): boolean {
    return getHistoryFtsTokenizer(db) !== 'none';
}

export function historyMessagesColumns(db: Database.Database): Set<string> {
    return new Set(db.prepare('PRAGMA table_info(history_messages)').all()
        .map((col) => String((col as { name?: string }).name ?? ''))
        .filter(Boolean));
}

export function getHistoryFtsLayout(db: Database.Database): HistoryFtsLayout {
    const layout = getIndexMeta(db, 'fts_layout');
    if (layout === 'contentless' || layout === 'legacy') return layout;
    return historyMessagesColumns(db).has('id') ? 'contentless' : 'legacy';
}

export function isHistoryFtsComplete(db: Database.Database): boolean {
    return getIndexMeta(db, 'fts_index_complete') !== '0';
}

export function isHistoryTopicStatsComplete(db: Database.Database): boolean {
    return getIndexMeta(db, 'topic_stats_complete') === '1' && tableExists(db, 'history_topic_stats');
}

export function markHistoryTopicStatsDirty(db: Database.Database): void {
    setIndexMeta(db, 'topic_stats_complete', '0');
}

export function rebuildHistoryTopicStats(db: Database.Database): { topics: number; messages: number; elapsedMs: number } {
    const startedAt = Date.now();
    let topics = 0;
    let messages = 0;
    const rebuild = db.transaction(() => {
        markHistoryTopicStatsDirty(db);
        db.exec(`
            CREATE TABLE IF NOT EXISTS history_topic_stats (
                topic TEXT PRIMARY KEY,
                count INTEGER NOT NULL,
                latest_time INTEGER NOT NULL
            ) WITHOUT ROWID;
            DELETE FROM history_topic_stats;
            INSERT INTO history_topic_stats(topic, count, latest_time)
            SELECT topic, COUNT(*), MAX(time_ms)
            FROM history_messages INDEXED BY idx_history_messages_topic_time_msg
            GROUP BY topic;
        `);
        const row = db.prepare(
            'SELECT COUNT(*) AS topics, COALESCE(SUM(count), 0) AS messages FROM history_topic_stats'
        ).get() as { topics: number; messages: number };
        topics = Number(row.topics) || 0;
        messages = Number(row.messages) || 0;
        setIndexMeta(db, 'topic_stats_built_at', Date.now());
        setIndexMeta(db, 'topic_stats_complete', '1');
    });
    rebuild();
    return { topics, messages, elapsedMs: Date.now() - startedAt };
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

function createHistoryFtsTable(
    db: Database.Database,
    tokenizer: Exclude<HistoryFtsTokenizer, 'none'>,
    layout: HistoryFtsLayout
): void {
    if (layout === 'contentless') {
        const compact = getIndexMeta(db, 'schema_version') === HISTORY_INDEX_SCHEMA_VERSION || historyMessagesColumns(db).has('search_text') === false;
        const contentlessOptions = compact
            ? 'content=\'\', detail=none, columnsize=0'
            : 'content=\'\', contentless_delete=1';
        db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS history_messages_fts USING fts5(
                search_text,
                tokenize='${tokenizer}',
                ${contentlessOptions}
            );
        `);
        return;
    }
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
    const hasLegacyV5Columns = ['id', 'bucket_ts', 'topic', 'msg_index', 'time_ms', 'search_text', 'payload_offset', 'payload_len', 'entry_offset', 'entry_len']
        .every((name) => columns.has(name));
    // Existing v5 shards stay writable/readable until their hour closes. New shards use v6.
    if (!options.rebuild && version === LEGACY_HISTORY_INDEX_SCHEMA_VERSION && hasLegacyV5Columns) {
        return getHistoryFtsTokenizer(db);
    }
    const hasPayloadColumn = columns.has('payload');
    const hasV4Columns = columns.has('payload_offset') && columns.has('payload_len') && columns.has('entry_offset') && columns.has('entry_len');
    const hasCompactColumns = hasTable && !columns.has('search_text') && columns.has('id') && hasV4Columns;
    const resetIndex = options.rebuild || hasPayloadColumn || !hasCompactColumns || version !== HISTORY_INDEX_SCHEMA_VERSION;

    if (resetIndex) {
        db.exec('DROP TABLE IF EXISTS history_messages_fts; DROP TABLE IF EXISTS history_fts_pending; DROP TABLE IF EXISTS history_topic_stats; DROP TABLE IF EXISTS history_messages;');
    }
    const layout: HistoryFtsLayout = 'contentless';
    if (layout === 'contentless') {
        db.exec(`
            CREATE TABLE IF NOT EXISTS history_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bucket_ts INTEGER NOT NULL,
                topic TEXT NOT NULL,
                msg_index INTEGER NOT NULL,
                time_ms INTEGER NOT NULL,
                payload_offset INTEGER NOT NULL,
                payload_len INTEGER NOT NULL,
                entry_offset INTEGER NOT NULL,
                entry_len INTEGER NOT NULL,
                UNIQUE (bucket_ts, topic, msg_index)
            );
            CREATE INDEX IF NOT EXISTS idx_history_messages_time_topic_msg ON history_messages(time_ms, topic, msg_index);
            CREATE INDEX IF NOT EXISTS idx_history_messages_topic_time_msg ON history_messages(topic, time_ms, msg_index);
            CREATE TABLE IF NOT EXISTS history_fts_pending (
                id INTEGER PRIMARY KEY
            );
        `);
    } else {
        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_history_messages_time_topic_msg ON history_messages(time_ms, topic, msg_index);
            CREATE INDEX IF NOT EXISTS idx_history_messages_topic_time_msg ON history_messages(topic, time_ms, msg_index);
        `);
    }

    setIndexMeta(db, 'schema_version', HISTORY_INDEX_SCHEMA_VERSION);
    let tokenizer = detectHistoryFtsTokenizer(db);
    if (tokenizer !== 'none') {
        try {
            createHistoryFtsTable(db, tokenizer, layout);
        } catch (error) {
            console.warn('[history-index] FTS5 table creation failed; keyword queries will use exact scan', {
                tokenizer,
                layout,
                schemaVersion: getIndexMeta(db, 'schema_version'),
                reason: (error as Error).message || String(error)
            });
            tokenizer = 'none';
            db.exec('DROP TABLE IF EXISTS history_messages_fts;');
        }
    } else if (tableExists(db, 'history_messages_fts')) {
        db.exec('DROP TABLE IF EXISTS history_messages_fts;');
    }

    setIndexMeta(db, 'fts5_enabled', tokenizer === 'none' ? '0' : '1');
    setIndexMeta(db, 'fts5_tokenizer', tokenizer);
    setIndexMeta(db, 'fts_layout', layout);
    setIndexMeta(db, 'fts_query_mode', tokenizer === 'trigram' ? 'compact-trigram-candidates' : 'scan');
    if (resetIndex) markHistoryTopicStatsDirty(db);
    if (options.initializeCompletion) {
        const complete = getIndexMeta(db, 'index_complete');
        if (resetIndex || !complete) {
            const row = db.prepare('SELECT COUNT(*) AS count FROM buckets').get() as { count: number };
            setIndexMeta(db, 'index_complete', row.count > 0 ? '0' : '1');
            setIndexMeta(db, 'indexed_message_count', 0);
            setIndexMeta(db, 'indexed_bucket_count', 0);
            setIndexMeta(db, 'fts_indexed_id', 0);
            setIndexMeta(db, 'fts_index_complete', row.count > 0 ? '0' : '1');
        }
    }
    return tokenizer;
}
