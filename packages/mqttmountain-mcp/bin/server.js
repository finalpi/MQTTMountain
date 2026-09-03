#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DATE_KEY_FILE_RE = /^\d{4}-\d{2}-\d{2}(?:-\d{2})?\.db$/;
const MAX_LIMIT = 5000;
const HISTORY_INDEX_SCHEMA_VERSION = '6';
const OFFSET_INDEX_SCHEMA_VERSIONS = new Set(['3', '4', '5', '6']);
const LEGACY_HISTORY_INDEX_SCHEMA_VERSION = '2';
const COMPRESSED_BUCKET_MAGIC = Buffer.from('MMZ1');
const COMPRESSED_BUCKET_HEADER_BYTES = 8;
const DEFAULT_STATUS_MINUTES = 10;
const DEFAULT_STATUS_TOPIC_LIMIT = 10;
const DEFAULT_STATUS_SCAN_LIMIT = 200;
const DEFAULT_PAYLOAD_SAMPLE_LIMIT = 5;
const DEFAULT_PAYLOAD_PREVIEW_CHARS = 300;
const DEFAULT_READ_TIMEOUT_MS = 15_000;
const MIN_READ_TIMEOUT_MS = 100;
const MAX_READ_TIMEOUT_MS = 120_000;
const READ_WORKER_MARKER = 'mqttmountain-read-worker-v1';
const PACKAGE_VERSION = '0.1.7';

function printHelp() {
  process.stdout.write(`mqttmountain-mcp ${PACKAGE_VERSION}

Usage:
  mqttmountain-mcp [--user-data-dir <dir>] [--log-dir <dir>]

Options:
  --user-data-dir <dir>  MQTTMountain app data directory.
  --log-dir <dir>        MQTTMountain message_logs directory.
  --help                 Show this help.

Environment:
  MQTTMOUNTAIN_USER_DATA_DIR
  MQTTMOUNTAIN_LOG_DIR
`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--user-data-dir') out.userDataDir = argv[++i];
    else if (arg === '--log-dir') out.logDir = argv[++i];
    else if (arg.startsWith('--user-data-dir=')) out.userDataDir = arg.slice('--user-data-dir='.length);
    else if (arg.startsWith('--log-dir=')) out.logDir = arg.slice('--log-dir='.length);
  }
  return out;
}

function defaultUserDataDir() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return bestExistingDir([
      path.join(base, 'mqttmountain'),
      path.join(base, 'MQTTMountain'),
      path.join(base, 'mqtt-mountain')
    ]);
  }
  if (process.platform === 'darwin') {
    const base = path.join(os.homedir(), 'Library', 'Application Support');
    return bestExistingDir([
      path.join(base, 'mqttmountain'),
      path.join(base, 'MQTTMountain'),
      path.join(base, 'mqtt-mountain')
    ]);
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return bestExistingDir([
    path.join(base, 'mqttmountain'),
    path.join(base, 'MQTTMountain'),
    path.join(base, 'mqtt-mountain')
  ]);
}

function bestExistingDir(candidates) {
  const scored = candidates.map((dir) => ({
    dir,
    score: (fs.existsSync(configDbPath(dir)) ? 2 : 0) + (fs.existsSync(path.join(dir, 'message_logs')) ? 1 : 0)
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].score > 0 ? scored[0].dir : candidates[0];
}

function configDbPath(userDataDir) {
  return path.join(userDataDir, 'mqtt_mountain.db');
}

function readConfigValue(userDataDir, key) {
  const dbFile = configDbPath(userDataDir);
  if (!fs.existsSync(dbFile)) return null;
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
    if (!row || typeof row.value !== 'string') return null;
    return JSON.parse(row.value);
  } finally {
    db.close();
  }
}

function resolveLogDir(args) {
  if (args.logDir) return path.resolve(args.logDir);
  if (process.env.MQTTMOUNTAIN_LOG_DIR) return path.resolve(process.env.MQTTMOUNTAIN_LOG_DIR);
  const userDataDir = path.resolve(args.userDataDir || process.env.MQTTMOUNTAIN_USER_DATA_DIR || defaultUserDataDir());
  try {
    const settings = readConfigValue(userDataDir, 'settings');
    if (settings && typeof settings.logDir === 'string' && settings.logDir.trim()) {
      return path.resolve(settings.logDir.trim());
    }
  } catch {
    // Fall back to the default app data layout when settings cannot be read.
  }
  return path.join(userDataDir, 'message_logs');
}

function sanitizeConnectionId(id) {
  if (!id) return '_none';
  const safe = String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe.length > 120 ? safe.slice(0, 120) : safe || '_empty';
}

function shardTimeRangeFromKey(shardKey) {
  const parts = shardKey.split('-').map(Number);
  const [year, month, day] = parts;
  const hour = parts.length >= 4 ? parts[3] : null;
  const start = hour == null
    ? new Date(year, month - 1, day, 0, 0, 0, 0)
    : new Date(year, month - 1, day, hour, 0, 0, 0);
  const endExclusive = hour == null
    ? new Date(year, month - 1, day + 1, 0, 0, 0, 0)
    : new Date(year, month - 1, day, hour + 1, 0, 0, 0);
  return { startTime: start.getTime(), endTime: endExclusive.getTime() - 1 };
}

function shardIntersectsRange(filePath, startTime, endTime) {
  const shardKey = path.basename(filePath, '.db');
  const range = shardTimeRangeFromKey(shardKey);
  return range.endTime >= startTime && range.startTime <= endTime;
}

function isCompressedBucketBlob(blob) {
  return Buffer.isBuffer(blob)
    && blob.length >= COMPRESSED_BUCKET_HEADER_BYTES
    && blob.subarray(0, COMPRESSED_BUCKET_MAGIC.length).equals(COMPRESSED_BUCKET_MAGIC);
}

function unpackBucketBlob(blob) {
  if (!Buffer.isBuffer(blob)) return null;
  if (!isCompressedBucketBlob(blob)) return blob;
  const expectedLength = blob.readUInt32LE(4);
  const raw = inflateRawSync(blob.subarray(COMPRESSED_BUCKET_HEADER_BYTES));
  if (raw.length !== expectedLength) {
    throw new Error(`compressed bucket length mismatch: expected ${expectedLength}, got ${raw.length}`);
  }
  return raw;
}

function readPayloadBytesSlice(blob, payloadOffset, payloadLen) {
  const raw = unpackBucketBlob(blob);
  if (!raw) return null;
  if (!Number.isSafeInteger(payloadOffset) || !Number.isSafeInteger(payloadLen)) return null;
  if (payloadOffset < 4 || payloadLen < 0 || payloadOffset + payloadLen > raw.length) return null;
  return raw.subarray(payloadOffset, payloadOffset + payloadLen);
}

function decodePreview(bytes, maxChars) {
  if (!Buffer.isBuffer(bytes)) return '';
  if (maxChars <= 0) return '';
  const text = bytes.subarray(0, Math.min(bytes.length, maxChars * 4)).toString('utf8');
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function formatHistoryMessage(base, state, payloadSource = {}) {
  const message = { ...base };
  const payloadMode = state.payloadMode;
  const payloadBytes = payloadSource.payloadBytes;
  const payloadText = payloadSource.payloadText;
  const payloadSize = Number.isFinite(payloadSource.payloadSize)
    ? payloadSource.payloadSize
    : Buffer.isBuffer(payloadBytes)
      ? payloadBytes.length
      : typeof payloadText === 'string'
        ? Buffer.byteLength(payloadText, 'utf8')
        : undefined;
  if (payloadMode === 'none') return message;
  if (payloadMode === 'metadata') {
    if (payloadSize != null) message.payloadSize = payloadSize;
    return message;
  }
  if (payloadMode === 'base64') {
    if (Buffer.isBuffer(payloadBytes)) message.payloadBase64 = payloadBytes.toString('base64');
    else if (typeof payloadText === 'string') message.payloadBase64 = Buffer.from(payloadText, 'utf8').toString('base64');
    if (payloadSize != null) message.payloadSize = payloadSize;
    return message;
  }
  if (payloadMode === 'preview') {
    const preview = Buffer.isBuffer(payloadBytes)
      ? decodePreview(payloadBytes, state.payloadPreviewChars)
      : String(payloadText || '').slice(0, state.payloadPreviewChars);
    message.payloadPreview = preview;
    if (payloadSize != null) message.payloadSize = payloadSize;
    message.payloadTruncated = payloadSize != null
      ? payloadSize > Buffer.byteLength(preview, 'utf8')
      : typeof payloadText === 'string' && payloadText.length > preview.length;
    return message;
  }
  message.payload = typeof payloadText === 'string'
    ? payloadText
    : Buffer.isBuffer(payloadBytes)
      ? payloadBytes.toString('utf8')
      : '';
  return message;
}

function decodeBucket(blob, bucketSec, topic, connectionId) {
  const out = [];
  const raw = unpackBucketBlob(blob);
  if (!raw || raw.length < 4) return out;
  const base = bucketSec * 1000;
  const count = raw.readUInt32LE(0);
  let cursor = 4;
  for (let i = 0; i < count && cursor + 6 <= raw.length; i++) {
    const offset = raw.readUInt16LE(cursor);
    cursor += 2;
    const length = raw.readUInt32LE(cursor);
    cursor += 4;
    if (cursor + length > raw.length) break;
    const payload = raw.subarray(cursor, cursor + length).toString('utf8');
    cursor += length;
    out.push({ connectionId, topic, payload, time: base + offset });
  }
  return out;
}

function listLogConnectionIds(logDir) {
  if (!fs.existsSync(logDir)) return [];
  return fs.readdirSync(logDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function listDayFiles(logDir, connectionId, descending = true) {
  const dir = path.join(logDir, sanitizeConnectionId(connectionId));
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((file) => DATE_KEY_FILE_RE.test(file))
    .sort((left, right) => {
      const a = shardTimeRangeFromKey(path.basename(left, '.db')).startTime;
      const b = shardTimeRangeFromKey(path.basename(right, '.db')).startTime;
      const delta = a - b || left.localeCompare(right);
      return descending ? -delta : delta;
    });
  return files.map((file) => path.join(dir, file));
}

function readConnections(userDataDir, logDir, includeMatchFields = false) {
  let saved = [];
  let selectedId = null;
  try {
    const config = readConfigValue(userDataDir, 'connections');
    if (config && Array.isArray(config.connections)) {
      selectedId = typeof config.selectedId === 'string' ? config.selectedId : null;
      saved = config.connections.map((item) => ({
        id: String(item.id || ''),
        name: String(item.name || item.id || ''),
        host: String(item.host || ''),
        port: Number(item.port || 0),
        protocol: String(item.protocol || ''),
        username: String(item.username || ''),
        subscriptionTopics: Array.isArray(item.subscriptions)
          ? item.subscriptions.map((sub) => String(sub.topic || '')).filter(Boolean)
          : []
      })).filter((item) => item.id);
    }
  } catch {
    saved = [];
  }

  const logIds = new Set(listLogConnectionIds(logDir));
  return {
    userDataDir,
    logDir,
    selectedId,
    connections: saved.map((item) => {
      const connection = {
        id: item.id,
        name: item.name,
        host: item.host,
        port: item.port,
        protocol: item.protocol,
        hasLogs: logIds.has(sanitizeConnectionId(item.id))
      };
      return includeMatchFields
        ? { ...connection, username: item.username, subscriptionTopics: item.subscriptionTopics }
        : connection;
    }),
    logOnlyConnectionIds: [...logIds].filter((id) => !saved.some((item) => sanitizeConnectionId(item.id) === id))
  };
}

function resolveConnectionId(userDataDir, logDir, input) {
  if (input.connectionId && input.connectionId.trim()) return input.connectionId.trim();
  const name = input.connectionName && input.connectionName.trim();
  const keyword = input.connectionKeyword && input.connectionKeyword.trim();
  const query = name || keyword;
  if (!query) return null;

  const config = readConnections(userDataDir, logDir, true);
  const matches = config.connections.filter((item) => item.name === query || item.id === query);
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new Error(`Connection "${query}" matched multiple connections. Use connectionId instead.`);
  }

  const fuzzyMatches = config.connections.filter((item) => connectionMatches(item, query));
  if (fuzzyMatches.length === 1) return fuzzyMatches[0].id;
  if (fuzzyMatches.length > 1 && config.selectedId && fuzzyMatches.some((item) => item.id === config.selectedId)) {
    return config.selectedId;
  }
  if (fuzzyMatches.length > 1) {
    throw new Error(`Connection "${query}" matched multiple connections. Use connectionId instead.`);
  }

  const logOnlyMatch = config.logOnlyConnectionIds.find((id) => id === query || sanitizeConnectionId(id) === query);
  if (logOnlyMatch) return logOnlyMatch;
  throw new Error(`Connection not found: ${query}`);
}

function readRecentMessages(logDir, connectionId, limit, topic) {
  return queryHistory(logDir, {
    connectionId,
    topic,
    order: 'desc',
    offset: 0,
    limit: Math.min(MAX_LIMIT, Math.max(1, limit)),
    payloadMode: 'full'
  });
}

function normalizeKeyword(value) {
  return String(value || '').replace(/\s+/gu, '').toLowerCase();
}

function parseKeywordTerms(input) {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : [input];
  return raw.map(normalizeKeyword).filter(Boolean);
}

function normalizeConditions(conditions) {
  if (!Array.isArray(conditions)) return [];
  return conditions
    .map((item) => ({
      term: normalizeKeyword(item?.term || ''),
      join: ['and', 'or', 'not'].includes(item?.join) ? item.join : 'and'
    }))
    .filter((item) => item.term);
}

function matchesConditions(hay, conditions) {
  if (!conditions.length) return true;
  let matched = true;
  let initialized = false;
  for (const condition of conditions) {
    const hit = hay.includes(condition.term);
    if (!initialized) {
      matched = condition.join === 'not' ? !hit : hit;
      initialized = true;
      continue;
    }
    if (condition.join === 'or') matched = matched || hit;
    else if (condition.join === 'not') matched = matched && !hit;
    else matched = matched && hit;
  }
  return matched;
}

function matchesSearchText(hay, conditions, terms, keywordLogic = 'and') {
  if (conditions.length) return matchesConditions(hay, conditions);
  if (!terms.length) return true;
  return keywordLogic === 'or'
    ? terms.some((term) => hay.includes(term))
    : terms.every((term) => hay.includes(term));
}

function matchesText(topic, payload, conditions, terms, keywordLogic = 'and') {
  return matchesSearchText(normalizeKeyword(String(topic || '') + String(payload || '')), conditions, terms, keywordLogic);
}

function connectionMatches(item, query) {
  const terms = expandConnectionSearchTerms(query);
  const hay = normalizeKeyword([
    item.id,
    item.name,
    item.host,
    item.username,
    ...(item.subscriptionTopics || [])
  ].join(' '));
  return terms.some((term) => hay.includes(term));
}

function expandConnectionSearchTerms(value) {
  const normalized = normalizeKeyword(value);
  const terms = [normalized];
  if (normalized.includes('深圳') && normalized.includes('星扬')) {
    terms.push('xingyang-szga', 'xingyangszga', 'szga');
  }
  return [...new Set(terms.filter(Boolean))];
}

function formatLocalTime(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function previewPayload(payload, maxChars) {
  if (!maxChars) return undefined;
  const text = String(payload || '').replace(/\s+/gu, ' ').trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function summarizePayload(payload, previewChars, fieldPaths = []) {
  const summary = {
    bytes: Buffer.byteLength(String(payload || ''), 'utf8'),
    type: 'text'
  };
  const payloadPreview = previewPayload(payload, previewChars);
  if (payloadPreview) summary.preview = payloadPreview;

  try {
    const parsed = JSON.parse(payload);
    summary.type = Array.isArray(parsed) ? 'json-array' : 'json-object';
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      summary.keys = Object.keys(parsed).slice(0, 20);
      const fields = pickPayloadFields(parsed, fieldPaths);
      if (Object.keys(fields).length) summary.fields = fields;
    }
  } catch {
    // Non-JSON payloads are still useful with byte length and preview.
  }
  return summary;
}

function pickPayloadFields(parsed, fieldPaths) {
  const defaultPaths = [
    'sn', 'status', 'statusVal', 'online', 'longitude', 'latitude', 'height', 'altitude',
    'gateway', 'timestamp', 'data.sn', 'data.mode_code', 'data.longitude', 'data.latitude',
    'data.height', 'data.capacity_percent'
  ];
  const out = {};
  for (const fieldPath of [...new Set([...defaultPaths, ...fieldPaths])]) {
    const value = getPayloadPath(parsed, fieldPath);
    if (value !== undefined && value !== null && typeof value !== 'object') out[fieldPath] = value;
  }
  return out;
}

function getPayloadPath(value, fieldPath) {
  return String(fieldPath || '').split('.').filter(Boolean)
    .reduce((current, key) => (current && typeof current === 'object' ? current[key] : undefined), value);
}

function readPayloadSamples(logDir, options) {
  const now = Date.now();
  const endTime = Number.isFinite(options.endTime) ? options.endTime : now;
  const minutes = Math.min(1440, Math.max(1, options.minutes || DEFAULT_STATUS_MINUTES));
  const startTime = Number.isFinite(options.startTime) ? options.startTime : endTime - minutes * 60_000;
  const limit = Math.min(50, Math.max(1, options.limit || DEFAULT_PAYLOAD_SAMPLE_LIMIT));
  const previewChars = Math.min(2000, Math.max(0, options.payloadPreviewChars ?? DEFAULT_PAYLOAD_PREVIEW_CHARS));
  const fieldPaths = Array.isArray(options.payloadFields) ? options.payloadFields : [];
  const messages = queryHistory(logDir, {
    connectionId: options.connectionId,
    topic: options.topic,
    topicKeyword: options.topicKeyword,
    keyword: options.keyword,
    startTime,
    endTime,
    order: 'desc',
    offset: 0,
    limit,
    payloadMode: 'full'
  });
  const samples = messages.map((message) => ({
    time: message.time,
    localTime: formatLocalTime(message.time),
    topic: message.topic,
    payload: summarizePayload(message.payload, previewChars, fieldPaths)
  }));
  return {
    startTime,
    endTime,
    startLocalTime: formatLocalTime(startTime),
    endLocalTime: formatLocalTime(endTime),
    samples
  };
}

function mergeStatusRow(mergeStat, row) {
  mergeStat(row.topic, Number(row.count || 0), Number(row.latest_time));
}

function readCompleteTopicStats(db, topic, topicKeyword, mergeStat) {
  if (getIndexMeta(db, 'topic_stats_complete') !== '1' || !tableExists(db, 'history_topic_stats')) {
    return false;
  }
  let sql = 'SELECT topic, count, latest_time FROM history_topic_stats WHERE 1 = 1';
  const params = [];
  if (topic) {
    sql += ' AND topic = ?';
    params.push(topic);
  }
  if (topicKeyword) {
    sql += ' AND instr(lower(topic), ?) > 0';
    params.push(topicKeyword);
  }
  for (const row of db.prepare(sql).iterate(...params)) mergeStatusRow(mergeStat, row);
  return true;
}

function listIndexedTopics(db) {
  return db.prepare(`
    WITH RECURSIVE topics(topic) AS (
      SELECT MIN(topic)
      FROM history_messages INDEXED BY idx_history_messages_topic_time_msg
      UNION ALL
      SELECT (
        SELECT MIN(topic)
        FROM history_messages INDEXED BY idx_history_messages_topic_time_msg
        WHERE topic > topics.topic
      )
      FROM topics
      WHERE topic IS NOT NULL
    )
    SELECT topic FROM topics WHERE topic IS NOT NULL
  `).pluck().all();
}

function readIndexedStatusRange(db, startTime, endTime, topic, topicKeyword, mergeStat) {
  if (topic || topicKeyword) {
    const topics = topic
      ? [topic]
      : listIndexedTopics(db).filter((value) => normalizeKeyword(value).includes(topicKeyword));
    const statement = db.prepare(`
      SELECT ? AS topic, COUNT(*) AS count, MAX(time_ms) AS latest_time
      FROM history_messages INDEXED BY idx_history_messages_topic_time_msg
      WHERE topic = ? AND time_ms BETWEEN ? AND ?
    `);
    for (const value of topics) mergeStatusRow(mergeStat, statement.get(value, value, startTime, endTime));
    return;
  }

  const statement = db.prepare(`
    SELECT topic, COUNT(*) AS count, MAX(time_ms) AS latest_time
    FROM history_messages INDEXED BY idx_history_messages_time_topic_msg
    WHERE time_ms BETWEEN ? AND ?
    GROUP BY topic
  `);
  for (const row of statement.iterate(startTime, endTime)) mergeStatusRow(mergeStat, row);
}

function readBucketStatusRange(db, connectionId, startTime, endTime, topic, topicKeyword, mergeStat) {
  const startSec = Math.floor(startTime / 1000);
  const endSec = Math.floor(endTime / 1000);
  const fullSecMin = Math.ceil(startTime / 1000);
  const fullSecMax = Math.floor((endTime - 999) / 1000);
  const partialSeconds = [...new Set([
    startTime % 1000 === 0 ? null : startSec,
    endTime % 1000 === 999 ? null : endSec
  ].filter((value) => value != null && value >= startSec && value <= endSec))];

  if (fullSecMin <= fullSecMax) {
    let sql = 'SELECT topic, SUM(count) AS count, MAX(bucket_ts) * 1000 + 999 AS latest_time FROM buckets WHERE bucket_ts BETWEEN ? AND ?';
    const params = [fullSecMin, fullSecMax];
    if (topic) {
      sql += ' AND topic = ?';
      params.push(topic);
    }
    if (topicKeyword) {
      sql += ' AND instr(lower(topic), ?) > 0';
      params.push(topicKeyword);
    }
    sql += ' GROUP BY topic';
    for (const row of db.prepare(sql).iterate(...params)) mergeStatusRow(mergeStat, row);
  }

  if (!partialSeconds.length) return;
  const placeholders = partialSeconds.map(() => '?').join(', ');
  let sql = `SELECT bucket_ts, topic, blob FROM buckets WHERE bucket_ts IN (${placeholders})`;
  const params = [...partialSeconds];
  if (topic) {
    sql += ' AND topic = ?';
    params.push(topic);
  }
  if (topicKeyword) {
    sql += ' AND instr(lower(topic), ?) > 0';
    params.push(topicKeyword);
  }
  for (const row of db.prepare(sql).iterate(...params)) {
    const matches = decodeBucket(row.blob, row.bucket_ts, row.topic, connectionId)
      .filter((message) => message.time >= startTime && message.time <= endTime);
    if (!matches.length) continue;
    mergeStat(row.topic, matches.length, matches[matches.length - 1].time);
  }
}

function readMessageStatus(logDir, options) {
  const now = Date.now();
  const endTime = Number.isFinite(options.endTime) ? options.endTime : now;
  const minutes = Math.min(1440, Math.max(1, options.minutes || DEFAULT_STATUS_MINUTES));
  const startTime = Number.isFinite(options.startTime) ? options.startTime : endTime - minutes * 60_000;
  const topicLimit = Math.min(50, Math.max(1, options.topicLimit || DEFAULT_STATUS_TOPIC_LIMIT));
  const sampleLimit = Math.min(10, Math.max(0, options.sampleLimit || 0));
  const payloadPreviewChars = Math.min(500, Math.max(0, options.payloadPreviewChars || 0));
  const scanLimit = Math.min(MAX_LIMIT, Math.max(1, options.scanLimit || DEFAULT_STATUS_SCAN_LIMIT));
  const topicStats = new Map();
  const keyword = normalizeKeyword(options.keyword || '');
  let total = 0;
  let latestTime = null;
  let truncated = false;
  let countMode = 'exact';
  let sampledMessages = [];

  const mergeStat = (topic, count, rowLatestTime) => {
    if (!count || !Number.isFinite(rowLatestTime)) return;
    total += count;
    latestTime = latestTime === null ? rowLatestTime : Math.max(latestTime, rowLatestTime);
    const stat = topicStats.get(topic) || { topic, count: 0, latestTime: rowLatestTime };
    stat.count += count;
    stat.latestTime = Math.max(stat.latestTime, rowLatestTime);
    topicStats.set(topic, stat);
  };

  if (keyword) {
    countMode = 'bounded-payload-scan';
    const scannedMessages = queryHistory(logDir, {
      connectionId: options.connectionId,
      topic: options.topic,
      topicKeyword: options.topicKeyword,
      keyword: options.keyword,
      startTime,
      endTime,
      order: 'desc',
      offset: 0,
      limit: Math.min(MAX_LIMIT, scanLimit + 1),
      payloadMode: sampleLimit > 0 && payloadPreviewChars > 0 ? 'preview' : 'none',
      payloadPreviewChars
    });
    truncated = scannedMessages.length > scanLimit
      || (scanLimit === MAX_LIMIT && scannedMessages.length === MAX_LIMIT);
    const messages = scannedMessages.slice(0, scanLimit);
    for (const message of messages) mergeStat(message.topic, 1, message.time);
    sampledMessages = messages.slice(0, sampleLimit);
  } else {
    const topic = options.topic && options.topic.trim() ? options.topic.trim() : null;
    const topicKeyword = normalizeKeyword(options.topicKeyword || '');
    const connectionIds = options.connectionId ? [options.connectionId] : listLogConnectionIds(logDir);
    for (const connectionId of connectionIds) {
      const files = listDayFiles(logDir, connectionId, true)
        .filter((filePath) => shardIntersectsRange(filePath, startTime, endTime));
      for (const filePath of files) {
        const db = new Database(filePath, { readonly: true, fileMustExist: true });
        try {
          const shardRange = shardTimeRangeFromKey(path.basename(filePath, '.db'));
          const fullyCovered = startTime <= shardRange.startTime && endTime >= shardRange.endTime;
          if (fullyCovered && readCompleteTopicStats(db, topic, topicKeyword, mergeStat)) continue;
          if (getUsableIndexVersion(db)) {
            readIndexedStatusRange(db, startTime, endTime, topic, topicKeyword, mergeStat);
          } else {
            readBucketStatusRange(db, connectionId, startTime, endTime, topic, topicKeyword, mergeStat);
          }
        } finally {
          db.close();
        }
      }
    }
    if (sampleLimit > 0) {
      sampledMessages = queryHistory(logDir, {
        connectionId: options.connectionId,
        topic: options.topic,
        topicKeyword: options.topicKeyword,
        startTime,
        endTime,
        order: 'desc',
        offset: 0,
        limit: sampleLimit,
        payloadMode: payloadPreviewChars > 0 ? 'preview' : 'none',
        payloadPreviewChars
      });
      if (sampledMessages[0]?.time != null) latestTime = Math.max(latestTime ?? 0, sampledMessages[0].time);
    }
  }

  const samples = sampledMessages.map((message) => ({
    time: message.time,
    localTime: formatLocalTime(message.time),
    topic: message.topic,
    ...(message.payloadPreview ? { payloadPreview: message.payloadPreview } : {})
  }));

  const topics = [...topicStats.values()]
    .sort((a, b) => b.latestTime - a.latestTime || b.count - a.count)
    .slice(0, topicLimit)
    .map((item) => ({
      topic: item.topic,
      count: item.count,
      latestTime: item.latestTime,
      latestLocalTime: formatLocalTime(item.latestTime)
    }));

  return {
    hasMessages: total > 0,
    total,
    truncated,
    countMode,
    scanLimit: keyword ? scanLimit : null,
    startTime,
    endTime,
    startLocalTime: formatLocalTime(startTime),
    endLocalTime: formatLocalTime(endTime),
    latestTime,
    latestLocalTime: formatLocalTime(latestTime),
    topics,
    samples
  };
}

function tableExists(db, tableName) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(tableName);
  return !!row;
}

function getIndexMeta(db, key) {
  if (!tableExists(db, 'history_index_meta')) return null;
  const row = db.prepare('SELECT value FROM history_index_meta WHERE key = ?').get(key);
  return row ? String(row.value ?? '') : null;
}

function getHistoryIndexSchemaVersion(db) {
  const version = getIndexMeta(db, 'schema_version');
  return version === HISTORY_INDEX_SCHEMA_VERSION || OFFSET_INDEX_SCHEMA_VERSIONS.has(version) || version === LEGACY_HISTORY_INDEX_SCHEMA_VERSION ? version : null;
}

function hasOffsetIndexSchema(schemaVersion) {
  return OFFSET_INDEX_SCHEMA_VERSIONS.has(schemaVersion);
}

function hasFtsTable(db) {
  return getIndexMeta(db, 'fts5_enabled') === '1'
    && tableExists(db, 'history_messages_fts');
}

function hasFtsIndex(db) {
  return hasFtsTable(db) && getIndexMeta(db, 'fts_index_complete') !== '0';
}

function escapeFtsPhrase(term) {
  if (/^[\p{L}\p{N}_]+$/u.test(term)) return `${term}*`;
  return `"${String(term).replace(/"/g, '""')}"`;
}

function buildFtsMatch(conditions, terms, keywordLogic = 'and') {
  if (conditions.length) {
    const parts = [];
    for (let i = 0; i < conditions.length; i++) {
      const item = conditions[i];
      const phrase = escapeFtsPhrase(item.term);
      if (i === 0) parts.push(item.join === 'not' ? `NOT ${phrase}` : phrase);
      else if (item.join === 'or') parts.push('OR', phrase);
      else if (item.join === 'not') parts.push('NOT', phrase);
      else parts.push('AND', phrase);
    }
    return parts.length ? parts.join(' ') : null;
  }
  if (!terms.length) return null;
  return terms.map(escapeFtsPhrase).join(keywordLogic === 'or' ? ' OR ' : ' AND ');
}

function hasShortFtsTerm(conditions, terms) {
  const values = conditions.length ? conditions.map((item) => item.term) : terms;
  return values.some((term) => Array.from(term).length < 3);
}

function hasPositiveFtsTerm(conditions, terms) {
  const values = conditions.length ? conditions.filter((item) => item.join !== 'not').map((item) => item.term) : terms;
  return values.length > 0;
}

function canUseFts(db, state) {
  return hasFtsIndex(db) && hasPositiveFtsTerm(state.conditions, state.terms) && !hasShortFtsTerm(state.conditions, state.terms);
}

function rowSearchText(row) {
  return normalizeKeyword(String(row.topic || '') + String(row.search_text || ''));
}

function getUsableIndexVersion(db) {
  if (!tableExists(db, 'history_messages')) return null;
  if (getIndexMeta(db, 'index_complete') !== '1') return null;
  return getHistoryIndexSchemaVersion(db);
}

function buildQueryState(options) {
  const startTime = Number.isFinite(options.startTime) ? options.startTime : -8640000000000000;
  const endTime = Number.isFinite(options.endTime) ? options.endTime : 8640000000000000;
  const conditions = normalizeConditions(options.conditions);
  const terms = conditions.length
    ? []
    : parseKeywordTerms(Array.isArray(options.keywords) && options.keywords.length ? options.keywords : options.keyword);
  const payloadMode = ['full', 'preview', 'metadata', 'base64', 'none'].includes(options.payloadMode)
    ? options.payloadMode
    : 'full';
  return {
    startTime,
    endTime,
    limit: Math.min(MAX_LIMIT, Math.max(1, options.limit || 200)),
    offset: Math.max(0, Number.isFinite(options.offset) ? Math.floor(options.offset) : 0),
    order: options.order === 'asc' ? 'asc' : 'desc',
    keywordLogic: options.keywordLogic === 'or' ? 'or' : 'and',
    topic: options.topic && options.topic.trim() ? options.topic.trim() : null,
    topicKeyword: normalizeKeyword(options.topicKeyword || ''),
    conditions,
    terms,
    payloadMode,
    payloadPreviewChars: Math.min(2000, Math.max(0, Number.isFinite(options.payloadPreviewChars) ? Math.floor(options.payloadPreviewChars) : 300))
  };
}

function createIndexedPayloadReader(filePath, connectionId, schemaVersion) {
  let db = null;
  let bucketStmt = null;
  const bucketCache = new Map();
  const hasOffsets = hasOffsetIndexSchema(schemaVersion);

  const ensureOpen = () => {
    if (db) return;
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    bucketStmt = db.prepare('SELECT blob FROM buckets WHERE bucket_ts = ? AND topic = ?');
  };

  return {
    read(row) {
      ensureOpen();
      const cacheKey = `${row.bucket_ts}|${row.topic}`;
      let cached = bucketCache.get(cacheKey);
      if (!cached) {
        const bucket = bucketStmt.get(row.bucket_ts, row.topic);
        if (!bucket) return null;
        cached = { raw: unpackBucketBlob(bucket.blob), decoded: null };
        bucketCache.set(cacheKey, cached);
        if (bucketCache.size > 32) bucketCache.delete(bucketCache.keys().next().value);
      }

      const payloadLen = hasOffsets ? row.payload_len : undefined;
      let payloadBytes = hasOffsets
        ? readPayloadBytesSlice(cached.raw, row.payload_offset ?? -1, row.payload_len ?? -1)
        : null;
      let payloadText = null;
      if (!payloadBytes) {
        if (!cached.decoded) cached.decoded = decodeBucket(cached.raw, row.bucket_ts, row.topic, connectionId);
        payloadText = cached.decoded[row.msg_index]?.payload ?? null;
      }
      if (!payloadBytes && payloadText == null) return null;
      return { payloadBytes, payloadText, payloadSize: payloadLen };
    },
    close() {
      if (db) db.close();
      db = null;
      bucketStmt = null;
      bucketCache.clear();
    }
  };
}

function createIndexedCandidate(connectionId, state, schemaVersion, row, payloadReader, verifyPayloadMatch) {
  const base = { connectionId, topic: row.topic, time: row.time_ms };
  const hasOffsets = hasOffsetIndexSchema(schemaVersion);
  let payloadSource = null;
  if (verifyPayloadMatch) {
    payloadSource = payloadReader.read(row);
    if (!payloadSource) return null;
    const payloadText = payloadSource.payloadText ?? payloadSource.payloadBytes?.toString('utf8') ?? '';
    if (!matchesText(row.topic, payloadText, state.conditions, state.terms, state.keywordLogic)) return null;
  }

  return {
    ...base,
    msgIndex: row.msg_index,
    materialize() {
      if (state.payloadMode === 'none') return formatHistoryMessage(base, state);
      if (state.payloadMode === 'metadata' && hasOffsets) {
        return formatHistoryMessage(base, state, { payloadSize: row.payload_len });
      }
      const source = payloadSource || payloadReader.read(row);
      return source ? formatHistoryMessage(base, state, source) : null;
    }
  };
}

function *iterateIndexedHistoryFile(db, filePath, connectionId, state, schemaVersion) {
  const compact = schemaVersion === '6';
  const useFts = !compact && canUseFts(db, state);
  const payloadReader = createIndexedPayloadReader(filePath, connectionId, schemaVersion);
  try {
    let sql;
    const params = [];
    if (useFts) {
      const match = buildFtsMatch(state.conditions, state.terms, state.keywordLogic);
      const hasOffsets = hasOffsetIndexSchema(schemaVersion);
      sql = hasOffsets
        ? `SELECT m.bucket_ts, m.time_ms, m.topic, m.msg_index, m.search_text, m.payload_offset, m.payload_len
           FROM history_messages_fts
           JOIN history_messages m
             ON m.bucket_ts = history_messages_fts.bucket_ts AND m.topic = history_messages_fts.topic AND m.msg_index = history_messages_fts.msg_index
           WHERE history_messages_fts MATCH ? AND m.time_ms BETWEEN ? AND ?`
        : `SELECT m.bucket_ts, m.time_ms, m.topic, m.msg_index, m.search_text
           FROM history_messages_fts
           JOIN history_messages m
             ON m.bucket_ts = history_messages_fts.bucket_ts AND m.topic = history_messages_fts.topic AND m.msg_index = history_messages_fts.msg_index
           WHERE history_messages_fts MATCH ? AND m.time_ms BETWEEN ? AND ?`;
      params.push(match, state.startTime, state.endTime);
      if (state.topic) {
        sql += ' AND m.topic = ?';
        params.push(state.topic);
      }
      if (state.topicKeyword) {
        sql += ' AND instr(lower(m.topic), ?) > 0';
        params.push(state.topicKeyword);
      }
      sql += state.order === 'asc'
        ? ' ORDER BY m.time_ms ASC, m.topic ASC, m.msg_index ASC'
        : ' ORDER BY m.time_ms DESC, m.topic DESC, m.msg_index DESC';
    } else {
      const hasOffsets = hasOffsetIndexSchema(schemaVersion);
      sql = compact
        ? 'SELECT bucket_ts, time_ms, topic, msg_index, payload_offset, payload_len FROM history_messages WHERE time_ms BETWEEN ? AND ?'
        : hasOffsets
          ? 'SELECT bucket_ts, time_ms, topic, msg_index, search_text, payload_offset, payload_len FROM history_messages WHERE time_ms BETWEEN ? AND ?'
          : 'SELECT bucket_ts, time_ms, topic, msg_index, search_text FROM history_messages WHERE time_ms BETWEEN ? AND ?';
      params.push(state.startTime, state.endTime);
      if (state.topic) {
        sql += ' AND topic = ?';
        params.push(state.topic);
      }
      if (state.topicKeyword) {
        sql += ' AND instr(lower(topic), ?) > 0';
        params.push(state.topicKeyword);
      }
      sql += state.order === 'asc'
        ? ' ORDER BY time_ms ASC, topic ASC, msg_index ASC'
        : ' ORDER BY time_ms DESC, topic DESC, msg_index DESC';
    }

    const verifyPayloadMatch = compact && (state.conditions.length > 0 || state.terms.length > 0);
    for (const row of db.prepare(sql).iterate(...params)) {
      if (useFts || (!compact && (state.conditions.length > 0 || state.terms.length > 0))) {
        if (!matchesSearchText(rowSearchText(row), state.conditions, state.terms, state.keywordLogic)) continue;
      }
      const candidate = createIndexedCandidate(
        connectionId,
        state,
        schemaVersion,
        row,
        payloadReader,
        verifyPayloadMatch
      );
      if (candidate) yield candidate;
    }
  } finally {
    payloadReader.close();
  }
}

function *iterateBucketHistoryFile(db, connectionId, state) {
  const secMin = Math.floor(Math.max(state.startTime, -8640000000) / 1000);
  const secMax = Math.ceil(Math.min(state.endTime, 8640000000000) / 1000);
  let sql = 'SELECT bucket_ts, topic, blob FROM buckets WHERE bucket_ts BETWEEN ? AND ?';
  const params = [secMin, secMax];
  if (state.topic) {
    sql += ' AND topic = ?';
    params.push(state.topic);
  }
  if (state.topicKeyword) {
    sql += ' AND instr(lower(topic), ?) > 0';
    params.push(state.topicKeyword);
  }
  sql += state.order === 'asc'
    ? ' ORDER BY bucket_ts ASC, topic ASC'
    : ' ORDER BY bucket_ts DESC, topic DESC';

  for (const row of db.prepare(sql).iterate(...params)) {
    const decoded = decodeBucket(row.blob, row.bucket_ts, row.topic, connectionId);
    const start = state.order === 'asc' ? 0 : decoded.length - 1;
    const end = state.order === 'asc' ? decoded.length : -1;
    const step = state.order === 'asc' ? 1 : -1;
    for (let i = start; i !== end; i += step) {
      const message = decoded[i];
      if (message.time < state.startTime || message.time > state.endTime) continue;
      if (!matchesText(message.topic, message.payload, state.conditions, state.terms, state.keywordLogic)) continue;
      const base = { connectionId, topic: message.topic, time: message.time };
      yield {
        ...base,
        msgIndex: i,
        materialize: () => formatHistoryMessage(base, state, { payloadText: message.payload })
      };
    }
  }
}

function *iterateConnectionHistory(logDir, connectionId, options) {
  const state = buildQueryState({ ...options, offset: 0 });
  const files = listDayFiles(logDir, connectionId, state.order !== 'asc')
    .filter((filePath) => shardIntersectsRange(filePath, state.startTime, state.endTime));
  for (const filePath of files) {
    const db = new Database(filePath, { readonly: true, fileMustExist: true });
    try {
      const schemaVersion = getUsableIndexVersion(db);
      if (schemaVersion) yield *iterateIndexedHistoryFile(db, filePath, connectionId, state, schemaVersion);
      else yield *iterateBucketHistoryFile(db, connectionId, state);
    } finally {
      db.close();
    }
  }
}

function compareHistoryMessages(left, right, order) {
  const timeDelta = Number(left.time || 0) - Number(right.time || 0);
  if (timeDelta !== 0) return order === 'asc' ? timeDelta : -timeDelta;
  const connectionDelta = String(left.connectionId || '').localeCompare(String(right.connectionId || ''));
  if (connectionDelta !== 0) return connectionDelta;
  const topicDelta = String(left.topic || '').localeCompare(String(right.topic || ''));
  return order === 'asc' ? topicDelta : -topicDelta;
}

function queryHistory(logDir, options) {
  const request = buildQueryState(options);
  const connectionIds = options.connectionId ? [options.connectionId] : listLogConnectionIds(logDir);
  const sources = connectionIds.map((connectionId) => {
    const iterator = iterateConnectionHistory(logDir, connectionId, options);
    return { iterator, current: iterator.next() };
  });

  const out = [];
  let skipped = 0;
  try {
    while (out.length < request.limit) {
      let selected = null;
      for (const source of sources) {
        if (source.current.done) continue;
        const candidate = source.current.value;
        if (!selected || compareHistoryMessages(candidate, selected.candidate, request.order) < 0) {
          selected = { source, candidate };
        }
      }
      if (!selected) break;

      const message = selected.candidate.materialize();
      selected.source.current = selected.source.iterator.next();
      if (!message) continue;
      if (skipped < request.offset) skipped += 1;
      else out.push(message);
    }
  } finally {
    for (const source of sources) source.iterator.return?.();
  }
  return out;
}

function readHistoryIndexStatus(logDir, options) {
  const connectionIds = options.connectionId ? [options.connectionId] : listLogConnectionIds(logDir);
  const status = {
    totalFiles: 0,
    indexedFiles: 0,
    incompleteFiles: 0,
    totalMessages: 0,
    fts5Enabled: false
  };

  for (const connectionId of connectionIds) {
    for (const filePath of listDayFiles(logDir, connectionId, true)) {
      status.totalFiles += 1;
      const db = new Database(filePath, { readonly: true, fileMustExist: true });
      try {
        const complete = getIndexMeta(db, 'index_complete') === '1'
          && Boolean(getHistoryIndexSchemaVersion(db));
        const messageCount = Number(getIndexMeta(db, 'indexed_message_count') || 0);
        if (complete) status.indexedFiles += 1;
        else status.incompleteFiles += 1;
        if (Number.isFinite(messageCount)) status.totalMessages += messageCount;
        status.fts5Enabled = status.fts5Enabled || getIndexMeta(db, 'fts5_enabled') === '1';
      } finally {
        db.close();
      }
    }
  }

  return status;
}

function jsonText(data) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

function installStdioExitHandlers(transport) {
  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await transport.close();
    } catch {
      // Ignore close errors while the stdio owner is already going away.
    } finally {
      process.exit(code);
    }
  };

  process.stdin.once('end', () => void shutdown(0));
  process.stdin.once('close', () => void shutdown(0));
  process.once('SIGINT', () => void shutdown(0));
  process.once('SIGTERM', () => void shutdown(0));
}

function normalizeReadTimeout(value) {
  if (!Number.isFinite(value)) return DEFAULT_READ_TIMEOUT_MS;
  return Math.min(MAX_READ_TIMEOUT_MS, Math.max(MIN_READ_TIMEOUT_MS, Math.floor(value)));
}

function readTimeoutInput(defaultValue = DEFAULT_READ_TIMEOUT_MS) {
  return z.number().int().min(MIN_READ_TIMEOUT_MS).max(MAX_READ_TIMEOUT_MS)
    .default(defaultValue)
    .describe('Hard timeout for the history read in milliseconds.');
}

function executeReadWorkerTask(task, payload) {
  if (task === 'recent') {
    return readRecentMessages(payload.logDir, payload.connectionId, payload.limit, payload.topic);
  }
  if (task === 'status') return readMessageStatus(payload.logDir, payload.options);
  if (task === 'samples') return readPayloadSamples(payload.logDir, payload.options);
  if (task === 'index-status') return readHistoryIndexStatus(payload.logDir, payload.options);
  if (task === 'query') return queryHistory(payload.logDir, payload.options);
  throw new Error(`Unknown read worker task: ${task}`);
}

let reusableReadWorker = null;
let reusableReadWorkerBusy = false;

function resetReusableReadWorker(worker) {
  if (reusableReadWorker !== worker) return;
  reusableReadWorker = null;
  reusableReadWorkerBusy = false;
}

function createReusableReadWorker() {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { marker: READ_WORKER_MARKER, persistent: true }
  });
  worker.unref();
  worker.on('error', () => resetReusableReadWorker(worker));
  worker.on('exit', () => resetReusableReadWorker(worker));
  reusableReadWorker = worker;
  return worker;
}

function runReadWorkerOn(worker, task, payload, options, reusable) {
  const timeoutMs = normalizeReadTimeout(options.timeoutMs);
  return new Promise((resolve, reject) => {
    let settled = false;
    const signal = options.signal;
    let timer;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (reusable && reusableReadWorker === worker) reusableReadWorkerBusy = false;
      if (error) reject(error);
      else resolve(value);
    };
    const stopWithError = (error) => {
      if (reusable) resetReusableReadWorker(worker);
      void worker.terminate();
      finish(error);
    };
    const onAbort = () => stopWithError(new Error(`MQTT history read cancelled (${task})`));
    const onMessage = (message) => {
      if (message?.ok) finish(null, message.value);
      else finish(new Error(message?.error || `MQTT history worker failed (${task})`));
    };
    const onError = (error) => finish(error);
    const onExit = (code) => {
      if (!settled) finish(new Error(`MQTT history worker exited with code ${code} (${task})`));
    };
    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
    timer = setTimeout(
      () => stopWithError(new Error(`MQTT history read timed out after ${timeoutMs}ms (${task})`)),
      timeoutMs
    );
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
    if (reusable) worker.postMessage({ task, payload });
  });
}

function runReadWorker(task, payload, options = {}) {
  if (!reusableReadWorkerBusy) {
    const worker = reusableReadWorker || createReusableReadWorker();
    reusableReadWorkerBusy = true;
    return runReadWorkerOn(worker, task, payload, options, true);
  }
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { marker: READ_WORKER_MARKER, task, payload }
  });
  return runReadWorkerOn(worker, task, payload, options, false);
}

async function runWorkerEntry() {
  const execute = ({ task, payload }) => {
    try {
      const value = executeReadWorkerTask(task, payload);
      parentPort?.postMessage({ ok: true, value });
    } catch (error) {
      parentPort?.postMessage({ ok: false, error: error?.stack || error?.message || String(error) });
    }
  };
  if (workerData.persistent) parentPort?.on('message', execute);
  else execute(workerData);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const userDataDir = path.resolve(args.userDataDir || process.env.MQTTMOUNTAIN_USER_DATA_DIR || defaultUserDataDir());
  const logDir = resolveLogDir(args);
  const server = new McpServer({ name: 'mqttmountain-mcp', version: PACKAGE_VERSION });

  server.registerTool(
    'mqttmountain_connections',
    {
      title: 'List MQTTMountain Connections',
      description: 'List saved MQTTMountain connections and log folders available to this MCP server.',
      inputSchema: z.object({})
    },
    async () => jsonText(readConnections(userDataDir, logDir))
  );

  server.registerTool(
    'mqttmountain_recent_messages',
    {
      title: 'Read Recent MQTT Messages',
      description: 'Read recent persisted MQTT messages for a MQTTMountain connection.',
      inputSchema: z.object({
        connectionId: z.string().optional().describe('MQTTMountain connection id. Use mqttmountain_connections first if unsure.'),
        connectionName: z.string().optional().describe('MQTTMountain connection name, for example "深圳星扬".'),
        connectionKeyword: z.string().optional().describe('Fuzzy connection keyword, for example "深圳星扬" or "xingyang-szga".'),
        topic: z.string().optional().describe('Exact MQTT topic filter.'),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(100),
        timeoutMs: readTimeoutInput()
      })
    },
    async (input, extra) => {
      const connectionId = resolveConnectionId(userDataDir, logDir, input);
      if (!connectionId) throw new Error('connectionId or connectionName is required.');
      return jsonText({
        logDir,
        connectionId,
        connectionName: input.connectionName,
        topic: input.topic,
        messages: await runReadWorker('recent', {
          logDir,
          connectionId,
          limit: input.limit,
          topic: input.topic
        }, { timeoutMs: input.timeoutMs, signal: extra?.signal })
      });
    }
  );

  server.registerTool(
    'mqttmountain_message_status',
    {
      title: 'Read Compact MQTT Message Status',
      description: 'One-call compact summary for checking whether recent messages arrived. Returns counts, latest time, and hot topics without full payloads by default.',
      inputSchema: z.object({
        connectionId: z.string().optional().describe('Optional MQTTMountain connection id.'),
        connectionName: z.string().optional().describe('Optional exact MQTTMountain connection name.'),
        connectionKeyword: z.string().optional().describe('Fuzzy connection keyword, for example "深圳星扬" or "xingyang-szga".'),
        topic: z.string().optional().describe('Exact MQTT topic filter.'),
        topicKeyword: z.string().optional().describe('Substring search in topic only.'),
        keyword: z.string().optional().describe('Substring search across topic and payload. Whitespace is ignored.'),
        minutes: z.number().int().min(1).max(1440).default(DEFAULT_STATUS_MINUTES).describe('Lookback window in minutes when startTime is omitted.'),
        startTime: z.number().optional().describe('Start timestamp in milliseconds since Unix epoch.'),
        endTime: z.number().optional().describe('End timestamp in milliseconds since Unix epoch. Defaults to now.'),
        topicLimit: z.number().int().min(1).max(50).default(DEFAULT_STATUS_TOPIC_LIMIT),
        scanLimit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_STATUS_SCAN_LIMIT).describe('Maximum newest matching messages counted for this compact status call.'),
        sampleLimit: z.number().int().min(0).max(10).default(0).describe('Number of recent sample messages to include. Defaults to 0 to save tokens.'),
        payloadPreviewChars: z.number().int().min(0).max(500).default(0).describe('Payload preview length for samples. Defaults to 0 to save tokens.'),
        timeoutMs: readTimeoutInput(60_000)
      })
    },
    async (input, extra) => {
      const connectionId = resolveConnectionId(userDataDir, logDir, input);
      const query = connectionId ? { ...input, connectionId } : input;
      return jsonText({
        connectionId,
        connectionName: input.connectionName,
        connectionKeyword: input.connectionKeyword,
        status: await runReadWorker('status', { logDir, options: query }, {
          timeoutMs: input.timeoutMs,
          signal: extra?.signal
        })
      });
    }
  );

  server.registerTool(
    'mqttmountain_payload_samples',
    {
      title: 'Read Compact MQTT Payload Samples',
      description: 'Read latest payload samples with compact JSON keys, common fields, and short previews.',
      inputSchema: z.object({
        connectionId: z.string().optional().describe('Optional MQTTMountain connection id.'),
        connectionName: z.string().optional().describe('Optional exact MQTTMountain connection name.'),
        connectionKeyword: z.string().optional().describe('Fuzzy connection keyword, for example "深圳星扬" or "xingyang-szga".'),
        topic: z.string().optional().describe('Exact MQTT topic filter.'),
        topicKeyword: z.string().optional().describe('Substring search in topic only.'),
        keyword: z.string().optional().describe('Substring search across topic and payload. Whitespace is ignored.'),
        minutes: z.number().int().min(1).max(1440).default(DEFAULT_STATUS_MINUTES).describe('Lookback window in minutes when startTime is omitted.'),
        startTime: z.number().optional().describe('Start timestamp in milliseconds since Unix epoch.'),
        endTime: z.number().optional().describe('End timestamp in milliseconds since Unix epoch. Defaults to now.'),
        limit: z.number().int().min(1).max(50).default(DEFAULT_PAYLOAD_SAMPLE_LIMIT),
        payloadPreviewChars: z.number().int().min(0).max(2000).default(DEFAULT_PAYLOAD_PREVIEW_CHARS),
        payloadFields: z.array(z.string()).optional().describe('Extra JSON field paths to extract, for example ["data.battery","data.mode_code"].'),
        timeoutMs: readTimeoutInput()
      })
    },
    async (input, extra) => {
      const connectionId = resolveConnectionId(userDataDir, logDir, input);
      const query = connectionId ? { ...input, connectionId } : input;
      return jsonText({
        connectionId,
        connectionName: input.connectionName,
        connectionKeyword: input.connectionKeyword,
        result: await runReadWorker('samples', { logDir, options: query }, {
          timeoutMs: input.timeoutMs,
          signal: extra?.signal
        })
      });
    }
  );

  server.registerTool(
    'mqttmountain_history_index_status',
    {
      title: 'Read MQTT History Index Status',
      description: 'Report how many MQTTMountain history DB files have complete indexed search tables.',
      inputSchema: z.object({
        connectionId: z.string().optional().describe('Optional MQTTMountain connection id. Omit to scan all log folders.'),
        connectionName: z.string().optional().describe('Optional exact MQTTMountain connection name.'),
        connectionKeyword: z.string().optional().describe('Fuzzy connection keyword, for example "深圳星扬" or "xingyang-szga".'),
        timeoutMs: readTimeoutInput()
      })
    },
    async (input, extra) => {
      const connectionId = resolveConnectionId(userDataDir, logDir, input);
      const query = connectionId ? { ...input, connectionId } : input;
      return jsonText({
        logDir,
        connectionId,
        connectionName: input.connectionName,
        connectionKeyword: input.connectionKeyword,
        status: await runReadWorker('index-status', { logDir, options: query }, {
          timeoutMs: input.timeoutMs,
          signal: extra?.signal
        })
      });
    }
  );

  server.registerTool(
    'mqttmountain_query_history',
    {
      title: 'Query MQTT Message History',
      description: 'Query persisted MQTTMountain messages by connection, topic, keyword, and timestamp range.',
      inputSchema: z.object({
        connectionId: z.string().optional().describe('Optional MQTTMountain connection id. Omit to search all log folders.'),
        connectionName: z.string().optional().describe('Optional MQTTMountain connection name, for example "深圳星扬".'),
        connectionKeyword: z.string().optional().describe('Fuzzy connection keyword, for example "深圳星扬" or "xingyang-szga".'),
        topic: z.string().optional().describe('Exact MQTT topic filter.'),
        keyword: z.string().optional().describe('Substring search across topic and payload. Whitespace is ignored.'),
        keywords: z.array(z.string()).optional().describe('Multiple keyword terms. Whitespace is ignored.'),
        keywordLogic: z.enum(['and', 'or']).default('and').describe('How to combine keywords when conditions are not provided.'),
        conditions: z.array(z.object({
          term: z.string(),
          join: z.enum(['and', 'or', 'not'])
        })).optional().describe('Advanced keyword conditions. Conditions take precedence over keyword/keywords.'),
        order: z.enum(['desc', 'asc']).default('desc').describe('Sort order by message time.'),
        offset: z.number().int().min(0).default(0).describe('Number of matched messages to skip for pagination.'),
        startTime: z.number().optional().describe('Start timestamp in milliseconds since Unix epoch.'),
        endTime: z.number().optional().describe('End timestamp in milliseconds since Unix epoch.'),
        payloadMode: z.enum(['full', 'preview', 'metadata', 'base64', 'none']).default('full').describe('Payload output mode. Default full preserves the legacy response shape.'),
        payloadPreviewChars: z.number().int().min(0).max(2000).default(300).describe('Preview character limit when payloadMode is preview.'),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(200),
        timeoutMs: readTimeoutInput()
      })
    },
    async (input, extra) => {
      const connectionId = resolveConnectionId(userDataDir, logDir, input);
      const query = connectionId ? { ...input, connectionId } : input;
      return jsonText({
        logDir,
        query,
        messages: await runReadWorker('query', { logDir, options: query }, {
          timeoutMs: input.timeoutMs,
          signal: extra?.signal
        })
      });
    }
  );

  const transport = new StdioServerTransport();
  installStdioExitHandlers(transport);
  await server.connect(transport);
}

if (!isMainThread && workerData?.marker === READ_WORKER_MARKER) {
  void runWorkerEntry();
} else {
  main().catch((error) => {
    process.stderr.write(`[mqttmountain-mcp] ${error?.stack || error}\n`);
    process.exit(1);
  });
}
