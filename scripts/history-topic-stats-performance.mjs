import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { app } = require('electron');
const Database = require('better-sqlite3');

function median(values) {
  return values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

function measure(fn, rounds = 7) {
  const elapsed = [];
  let rows = [];
  for (let round = 0; round < rounds; round++) {
    const startedAt = performance.now();
    rows = fn();
    elapsed.push(performance.now() - startedAt);
  }
  return { rows, medianMs: Number(median(elapsed).toFixed(3)) };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttmountain-topic-stats-performance-'));
  const dbPath = path.join(root, 'fixture.db');
  try {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE buckets (
        bucket_ts INTEGER NOT NULL,
        topic TEXT NOT NULL,
        blob BLOB NOT NULL,
        count INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        PRIMARY KEY(bucket_ts, topic)
      ) WITHOUT ROWID;
      CREATE TABLE history_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bucket_ts INTEGER NOT NULL,
        topic TEXT NOT NULL,
        msg_index INTEGER NOT NULL,
        time_ms INTEGER NOT NULL
      );
      CREATE INDEX idx_history_messages_topic_time_msg ON history_messages(topic, time_ms, msg_index);
      CREATE TABLE history_topic_stats (
        topic TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        latest_time INTEGER NOT NULL
      ) WITHOUT ROWID;
    `);
    const blob = Buffer.alloc(8 * 1024, 120);
    const insertBucket = db.prepare('INSERT INTO buckets VALUES (?, ?, ?, 1, ?)');
    const insertMessage = db.prepare('INSERT INTO history_messages(bucket_ts, topic, msg_index, time_ms) VALUES (?, ?, 0, ?)');
    db.transaction(() => {
      for (let index = 0; index < 10_000; index++) {
        const topic = `topic/${index % 200}`;
        const bucketTs = 1_780_000_000 + index;
        insertBucket.run(bucketTs, topic, blob, blob.length);
        insertMessage.run(bucketTs, topic, bucketTs * 1000 + (index % 1000));
      }
    })();

    const buildStartedAt = performance.now();
    db.exec(`
      DELETE FROM history_topic_stats;
      INSERT INTO history_topic_stats(topic, count, latest_time)
      SELECT topic, COUNT(*), MAX(time_ms)
      FROM history_messages INDEXED BY idx_history_messages_topic_time_msg
      GROUP BY topic;
    `);
    const buildMs = performance.now() - buildStartedAt;
    db.pragma('wal_checkpoint(TRUNCATE)');

    const bucketScan = measure(() => db.prepare(
      'SELECT topic, SUM(count) AS count, MAX(bucket_ts * 1000) AS latest_time FROM buckets GROUP BY topic'
    ).all());
    const topicStats = measure(() => db.prepare(
      'SELECT topic, count, latest_time FROM history_topic_stats'
    ).all());
    const plan = db.prepare(
      'EXPLAIN QUERY PLAN SELECT topic, COUNT(*), MAX(time_ms) FROM history_messages INDEXED BY idx_history_messages_topic_time_msg GROUP BY topic'
    ).all().map((row) => String(row.detail || '')).join(' | ');
    if (bucketScan.rows.length !== 200 || topicStats.rows.length !== 200) throw new Error('topic benchmark row count mismatch');
    if (!/COVERING INDEX idx_history_messages_topic_time_msg/i.test(plan)) throw new Error(`topic stats build did not use covering index: ${plan}`);
    if (topicStats.medianMs * 10 >= bucketScan.medianMs) {
      throw new Error(`topic stats lookup was less than 10x faster: bucket=${bucketScan.medianMs}ms stats=${topicStats.medianMs}ms`);
    }
    console.log(JSON.stringify({
      fixture: { buckets: 10_000, topics: 200, blobBytesPerBucket: blob.length, dbBytes: fs.statSync(dbPath).size },
      oneTimeStatsBuildMs: Number(buildMs.toFixed(3)),
      beforeBucketGroupMedianMs: bucketScan.medianMs,
      afterTopicStatsMedianMs: topicStats.medianMs,
      querySpeedup: Number((bucketScan.medianMs / Math.max(0.001, topicStats.medianMs)).toFixed(1)),
      buildPlan: plan
    }, null, 2));
    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => app?.exit(process.exitCode || 0));
