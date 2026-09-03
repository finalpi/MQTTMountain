import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const TOPIC = 'fixture/query';
const DAY = { year: 2026, month: 6, day: 15 };

function localTime(hour, minute, second = 0) {
  return new Date(DAY.year, DAY.month, DAY.day, hour, minute, second, 0).getTime();
}

function encodeBucket(bucketSec, payload, offset = 0) {
  return encodeBucketItems([{ payload, offset }]);
}

function encodeBucketItems(items) {
  const chunks = [];
  const count = Buffer.alloc(4);
  count.writeUInt32LE(items.length, 0);
  chunks.push(count);
  for (const item of items) {
    const bytes = Buffer.from(item.payload, 'utf8');
    const header = Buffer.alloc(6);
    header.writeUInt16LE(item.offset, 0);
    header.writeUInt32LE(bytes.length, 2);
    chunks.push(header, bytes);
  }
  return Buffer.concat(chunks);
}

function createBucketsTable(db) {
  db.exec(`CREATE TABLE buckets (
    bucket_ts INTEGER NOT NULL,
    topic TEXT NOT NULL,
    blob BLOB NOT NULL,
    count INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    PRIMARY KEY(bucket_ts, topic)
  )`);
}

function createCompleteTopicStats(db) {
  db.exec(`
    CREATE TABLE history_index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE history_topic_stats (
      topic TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      latest_time INTEGER NOT NULL
    );
    INSERT INTO history_topic_stats(topic, count, latest_time)
    SELECT topic, SUM(count), MAX(bucket_ts) * 1000
    FROM buckets
    GROUP BY topic;
    INSERT INTO history_index_meta(key, value) VALUES ('topic_stats_complete', '1');
  `);
}

function createHistoryIndex(db, rows) {
  db.exec(`
    CREATE TABLE history_index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE history_messages (
      bucket_ts INTEGER NOT NULL,
      time_ms INTEGER NOT NULL,
      topic TEXT NOT NULL,
      msg_index INTEGER NOT NULL,
      search_text TEXT NOT NULL,
      PRIMARY KEY(bucket_ts, topic, msg_index)
    );
    CREATE INDEX idx_history_messages_time_topic_msg ON history_messages(time_ms, topic, msg_index);
    CREATE INDEX idx_history_messages_topic_time_msg ON history_messages(topic, time_ms, msg_index);
  `);
  const insert = db.prepare(`
    INSERT INTO history_messages(bucket_ts, time_ms, topic, msg_index, search_text)
    VALUES (?, ?, ?, 0, ?)
  `);
  for (const row of rows) {
    insert.run(Math.floor(row.time / 1000), row.time, row.topic || TOPIC, `${row.topic || TOPIC}${row.payload}`.toLowerCase());
  }
  db.prepare("INSERT INTO history_index_meta(key, value) VALUES ('schema_version', '2'), ('index_complete', '1')").run();
}

function writeFixture(logRoot, connectionId, fileName, rows, options = {}) {
  const dir = path.join(logRoot, connectionId);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, fileName));
  try {
    createBucketsTable(db);
    const insert = db.prepare('INSERT INTO buckets(bucket_ts, topic, blob, count, bytes) VALUES (?, ?, ?, 1, ?)');
    const writeRows = db.transaction(() => {
      for (const row of rows) {
        const blob = encodeBucket(Math.floor(row.time / 1000), row.payload, row.time % 1000);
        insert.run(Math.floor(row.time / 1000), row.topic || TOPIC, blob, blob.length);
      }
    });
    writeRows();
    if (options.historyIndex) createHistoryIndex(db, rows);
    if (options.topicStats) createCompleteTopicStats(db);
  } finally {
    db.close();
  }
}

function writeMultiBucketFixture(logRoot, connectionId, fileName, bucketSec, topics, options = {}) {
  const dir = path.join(logRoot, connectionId);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, fileName));
  try {
    createBucketsTable(db);
    const insert = db.prepare('INSERT INTO buckets(bucket_ts, topic, blob, count, bytes) VALUES (?, ?, ?, ?, ?)');
    for (const row of topics) {
      const blob = encodeBucketItems(row.items);
      insert.run(bucketSec, row.topic, blob, row.items.length, blob.length);
    }
    if (options.topicStats) createCompleteTopicStats(db);
  } finally {
    db.close();
  }
}

function writeDeepIndexFixture(logRoot) {
  const dir = path.join(logRoot, 'deep-index');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, '2026-07-15-06.db'));
  try {
    db.exec(`
      CREATE TABLE history_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE history_messages (
        bucket_ts INTEGER NOT NULL,
        time_ms INTEGER NOT NULL,
        topic TEXT NOT NULL,
        msg_index INTEGER NOT NULL,
        payload_offset INTEGER NOT NULL,
        payload_len INTEGER NOT NULL
      );
      CREATE INDEX idx_history_messages_time_topic_msg ON history_messages(time_ms, topic, msg_index);
      CREATE INDEX idx_history_messages_topic_time_msg ON history_messages(topic, time_ms, msg_index);
      INSERT INTO history_index_meta(key, value) VALUES ('schema_version', '6'), ('index_complete', '1');
    `);
    const base = localTime(6, 0);
    const insert = db.prepare(`
      INSERT INTO history_messages(bucket_ts, time_ms, topic, msg_index, payload_offset, payload_len)
      VALUES (?, ?, 'fixture/deep-index', ?, 4, 0)
    `);
    db.transaction(() => {
      for (let index = 0; index <= 120_000; index += 1) {
        insert.run(Math.floor((base + index) / 1000), base + index, index);
      }
    })();
  } finally {
    db.close();
  }
}

function createFixtures(logRoot) {
  writeDeepIndexFixture(logRoot);
  writeFixture(logRoot, 'a-older', '2026-07-15-09.db', [
    { time: localTime(9, 10), payload: '{"marker":"old-a-1"}' },
    { time: localTime(9, 11), payload: '{"marker":"old-a-2"}' }
  ]);
  writeFixture(logRoot, 'z-newer', '2026-07-15-09.db', [
    { time: localTime(9, 20), payload: '{"marker":"new-z-1"}' },
    { time: localTime(9, 30), payload: '{"marker":"new-z-2"}' }
  ]);

  const indexedNewer = [];
  const indexedOlder = [];
  for (let i = 0; i < 100; i += 1) {
    indexedNewer.push({ time: localTime(8, 0) + i * 1000, payload: `{"marker":"indexed-new-${i}"}` });
  }
  for (let i = 0; i < 200; i += 1) {
    indexedOlder.push({ time: localTime(7, 0) + i * 1000, payload: `{"marker":"indexed-old-${i}"}` });
  }
  writeFixture(logRoot, 'indexed-pages', '2026-07-15-08.db', indexedNewer, { historyIndex: true });
  writeFixture(logRoot, 'indexed-pages', '2026-07-15-07.db', indexedOlder, { historyIndex: true });

  writeFixture(logRoot, 'hour-prune', '2026-07-15-09.db', [
    { time: localTime(9, 15), payload: '{"marker":"right-hour"}' }
  ]);
  fs.writeFileSync(path.join(logRoot, 'hour-prune', '2026-07-15-08.db'), 'not a sqlite database');

  const largeRows = [];
  const largeTime = localTime(10, 15);
  for (let i = 0; i < 12_000; i += 1) {
    largeRows.push({
      time: largeTime,
      topic: `fixture/large/${String(i).padStart(5, '0')}`,
      payload: `{"marker":"large-${i}","padding":"${'x'.repeat(128)}"}`
    });
  }
  writeFixture(logRoot, 'large-shard', '2026-07-15-10.db', largeRows);

  const boundarySec = Math.floor(localTime(11, 0) / 1000);
  writeMultiBucketFixture(logRoot, 'boundary-ms', '2026-07-15-11.db', boundarySec, [
    {
      topic: 'fixture/boundary/match',
      items: [
        { offset: 100, payload: '{"marker":"before"}' },
        { offset: 500, payload: '{"marker":"inside"}' },
        { offset: 900, payload: '{"marker":"after"}' }
      ]
    },
    { topic: 'fixture/boundary/other', items: [{ offset: 500, payload: '{"marker":"other"}' }] }
  ], { topicStats: true });

  for (let hour = 0; hour < 24; hour += 1) {
    const rows = [];
    const hourStart = new Date(2026, 6, 16, hour, 0, 0, 0).getTime();
    for (let i = 0; i < 500; i += 1) {
      rows.push({
        time: hourStart + i * 1000,
        topic: `fixture/day/${i % 12}`,
        payload: `{"hour":${hour},"index":${i}}`
      });
    }
    writeFixture(logRoot, 'day-scale', `2026-07-16-${String(hour).padStart(2, '0')}.db`, rows, { topicStats: true });
  }
}

function toolJson(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('MCP tool returned no JSON text');
  return JSON.parse(text);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttmountain-mcp-query-'));
  createFixtures(logRoot);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('bin/server.js'), '--log-dir', logRoot]
  });
  const client = new Client({ name: 'mqttmountain-mcp-query-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const range = { startTime: localTime(9, 0), endTime: localTime(9, 59, 59) + 999 };

    let timedOut = false;
    try {
      const timeoutResult = await client.callTool({
        name: 'mqttmountain_query_history',
        arguments: {
          connectionId: 'large-shard',
          keyword: 'marker-that-does-not-exist',
          limit: 1,
          timeoutMs: 100
        }
      });
      const timeoutText = timeoutResult.content?.find((item) => item.type === 'text')?.text || '';
      timedOut = timeoutResult.isError === true && /timed out/i.test(timeoutText);
    } catch (error) {
      timedOut = /timed out/i.test(String(error));
    }
    expect(timedOut, 'history worker did not enforce its hard timeout');

    const global = toolJson(await client.callTool({
      name: 'mqttmountain_query_history',
      arguments: { ...range, order: 'desc', payloadMode: 'full', limit: 2, timeoutMs: 5000 }
    }));
    expect(global.messages?.[0]?.payload.includes('new-z-2'), 'global query did not return the newest connection first');
    expect(global.messages?.[1]?.payload.includes('new-z-1'), 'global query did not merge connection results');

    const paged = toolJson(await client.callTool({
      name: 'mqttmountain_query_history',
      arguments: { ...range, order: 'desc', payloadMode: 'full', offset: 1, limit: 1, timeoutMs: 5000 }
    }));
    expect(paged.messages?.[0]?.payload.includes('new-z-1'), 'global offset was applied before merging connections');

    const exactHour = toolJson(await client.callTool({
      name: 'mqttmountain_query_history',
      arguments: { connectionId: 'hour-prune', ...range, payloadMode: 'full', limit: 10, timeoutMs: 5000 }
    }));
    expect(exactHour.messages?.length === 1 && exactHour.messages[0].payload.includes('right-hour'), 'hour shard pruning opened an out-of-range file');

    const indexedAcrossShards = toolJson(await client.callTool({
      name: 'mqttmountain_query_history',
      arguments: {
        connectionId: 'indexed-pages',
        startTime: localTime(7, 0),
        endTime: localTime(8, 59, 59) + 999,
        order: 'desc',
        offset: 128,
        limit: 1,
        timeoutMs: 5000
      }
    }));
    expect(indexedAcrossShards.messages?.[0]?.payload.includes('indexed-old-'), 'indexed pagination reapplied the connection offset to every shard');

    const veryDeepStarted = Date.now();
    const veryDeepPage = toolJson(await client.callTool({
      name: 'mqttmountain_query_history',
      arguments: {
        connectionId: 'deep-index',
        startTime: localTime(6, 0),
        endTime: localTime(6, 59, 59) + 999,
        order: 'desc',
        offset: 100_000,
        limit: 1,
        payloadMode: 'none',
        timeoutMs: 5000
      }
    }));
    const veryDeepElapsedMs = Date.now() - veryDeepStarted;
    expect(veryDeepPage.messages?.[0]?.time === localTime(6, 0) + 20_000, '100,000-row streaming offset returned the wrong indexed row');
    expect(veryDeepElapsedMs < 5000, '100,000-row streaming offset exceeded five seconds');

    const status = toolJson(await client.callTool({
      name: 'mqttmountain_message_status',
      arguments: { ...range, sampleLimit: 1, payloadPreviewChars: 100, timeoutMs: 5000 }
    }));
    expect(status.status?.samples?.[0]?.payloadPreview.includes('new-z-2'), 'status samples were biased toward the first connection');
    expect(status.status?.total === 5 && status.status?.countMode === 'exact' && status.status?.truncated === false, 'non-payload status counts were not exact');

    const boundedStatus = toolJson(await client.callTool({
      name: 'mqttmountain_message_status',
      arguments: {
        connectionId: 'large-shard',
        startTime: localTime(10, 0),
        endTime: localTime(10, 59, 59) + 999,
        keyword: 'large-',
        scanLimit: 100,
        timeoutMs: 5000
      }
    }));
    expect(boundedStatus.status?.total === 100 && boundedStatus.status?.truncated === true, 'bounded status did not report truncation');

    const boundaryBase = localTime(11, 0);
    const boundaryStatus = toolJson(await client.callTool({
      name: 'mqttmountain_message_status',
      arguments: {
        connectionId: 'boundary-ms',
        topicKeyword: 'boundary/match',
        startTime: boundaryBase + 250,
        endTime: boundaryBase + 750,
        timeoutMs: 5000
      }
    }));
    expect(boundaryStatus.status?.total === 1, 'partial-second status count included out-of-range messages');
    expect(boundaryStatus.status?.latestTime === boundaryBase + 500, 'partial-second latest time was not decoded exactly');

    const dayStarted = Date.now();
    const dayStatus = toolJson(await client.callTool({
      name: 'mqttmountain_message_status',
      arguments: {
        connectionId: 'day-scale',
        startTime: new Date(2026, 6, 16, 0, 0, 0, 0).getTime(),
        endTime: new Date(2026, 6, 16, 23, 59, 59, 999).getTime(),
        timeoutMs: 15000
      }
    }));
    const dayElapsedMs = Date.now() - dayStarted;
    expect(dayStatus.status?.total === 12_000 && dayStatus.status?.countMode === 'exact', '24-hour topic-summary aggregation returned the wrong exact count');
    expect(dayElapsedMs < 15_000, '24-hour exact topic-summary aggregation exceeded 15 seconds');

    const started = Date.now();
    const recent = toolJson(await client.callTool({
      name: 'mqttmountain_recent_messages',
      arguments: { connectionId: 'large-shard', limit: 3, timeoutMs: 5000 }
    }));
    expect(recent.messages?.length === 3, 'large-shard recent query returned the wrong limit');
    expect(Date.now() - started < 5000, 'large-shard recent query exceeded its hard timeout');

    const deepStarted = Date.now();
    const deepPage = toolJson(await client.callTool({
      name: 'mqttmountain_query_history',
      arguments: { connectionId: 'large-shard', offset: 6000, limit: 1, timeoutMs: 10000 }
    }));
    const deepElapsedMs = Date.now() - deepStarted;
    expect(deepPage.messages?.[0]?.payload.includes('large-5999'), 'deep offset compatibility or ordering regressed');

    const aborter = new AbortController();
    const cancelledRead = client.callTool({
      name: 'mqttmountain_query_history',
      arguments: {
        connectionId: 'large-shard',
        keyword: 'another-marker-that-does-not-exist',
        limit: 1,
        timeoutMs: 5000
      }
    }, undefined, { signal: aborter.signal });
    setTimeout(() => aborter.abort(), 25);
    let cancelled = false;
    try {
      await cancelledRead;
    } catch {
      cancelled = true;
    }
    expect(cancelled, 'client cancellation did not abort the history read');

    const afterCancel = toolJson(await client.callTool({
      name: 'mqttmountain_recent_messages',
      arguments: { connectionId: 'z-newer', limit: 1, timeoutMs: 5000 }
    }));
    expect(afterCancel.messages?.length === 1, 'stdio server did not recover after cancellation');

    console.log('✓ globally ordered multi-connection history and pagination');
    console.log('✓ precise hourly shard pruning');
    console.log('✓ indexed deep pagination crosses shard boundaries without gaps');
    console.log(`✓ 100,000-row indexed streaming offset (${veryDeepElapsedMs}ms)`);
    console.log('✓ globally newest status sample');
    console.log('✓ bounded status count reports truncation');
    console.log('✓ partial-second boundary ignores whole-shard topic summaries');
    console.log(`✓ 12,000-message / 24-hour exact topic-summary aggregation (${dayElapsedMs}ms)`);
    console.log('✓ SQL-limited recent read on a 12,000-bucket shard');
    console.log(`✓ streaming merge preserves offsets above 5000 (${deepElapsedMs}ms)`);
    console.log('✓ worker-enforced hard timeout');
    console.log('✓ cancellable read leaves the stdio server responsive');
  } finally {
    await client.close().catch(() => undefined);
    fs.rmSync(logRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
