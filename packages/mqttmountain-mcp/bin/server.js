#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DATE_KEY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.db$/;
const MAX_LIMIT = 5000;
const INDEX_QUERY_CHUNK_SIZE = 1000;
const BUCKET_QUERY_CHUNK_SIZE = 256;
const HISTORY_INDEX_SCHEMA_VERSION = '5';
const OFFSET_INDEX_SCHEMA_VERSIONS = new Set(['3', '4', '5']);
const LEGACY_HISTORY_INDEX_SCHEMA_VERSION = '2';
const DEFAULT_STATUS_MINUTES = 10;
const DEFAULT_STATUS_TOPIC_LIMIT = 10;
const DEFAULT_PAYLOAD_SAMPLE_LIMIT = 5;
const DEFAULT_PAYLOAD_PREVIEW_CHARS = 300;
const PACKAGE_VERSION = '0.1.4';

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

function dayStartTsFromKey(dayKey) {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
}

function dayEndTsFromKey(dayKey) {
  return dayStartTsFromKey(dayKey) + 86_400_000 - 1;
}

function readPayloadBytesSlice(blob, payloadOffset, payloadLen) {
  if (!Buffer.isBuffer(blob)) return null;
  if (!Number.isSafeInteger(payloadOffset) || !Number.isSafeInteger(payloadLen)) return null;
  if (payloadOffset < 4 || payloadLen < 0 || payloadOffset + payloadLen > blob.length) return null;
  return blob.subarray(payloadOffset, payloadOffset + payloadLen);
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
  if (!Buffer.isBuffer(blob) || blob.length < 4) return out;
  const base = bucketSec * 1000;
  const count = blob.readUInt32LE(0);
  let cursor = 4;
  for (let i = 0; i < count && cursor + 6 <= blob.length; i++) {
    const offset = blob.readUInt16LE(cursor);
    cursor += 2;
    const length = blob.readUInt32LE(cursor);
    cursor += 4;
    if (cursor + length > blob.length) break;
    const payload = blob.subarray(cursor, cursor + length).toString('utf8');
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
    .sort();
  if (descending) files.reverse();
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
  const max = Math.min(MAX_LIMIT, Math.max(1, limit));
  const topicFilter = topic && topic.trim() ? topic.trim() : null;
  const out = [];
  for (const filePath of listDayFiles(logDir, connectionId, true)) {
    if (out.length >= max) break;
    const db = new Database(filePath, { readonly: true, fileMustExist: true });
    try {
      const rows = topicFilter
        ? db.prepare('SELECT bucket_ts, topic, blob FROM buckets WHERE topic = ? ORDER BY bucket_ts DESC').all(topicFilter)
        : db.prepare('SELECT bucket_ts, topic, blob FROM buckets ORDER BY bucket_ts DESC').all();
      for (const row of rows) {
        const decoded = decodeBucket(row.blob, row.bucket_ts, row.topic, connectionId);
        for (let i = decoded.length - 1; i >= 0; i--) {
          out.push(decoded[i]);
          if (out.length >= max) break;
        }
        if (out.length >= max) break;
      }
    } finally {
      db.close();
    }
  }
  return out;
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
  const topic = options.topic && options.topic.trim() ? options.topic.trim() : null;
  const topicKeyword = normalizeKeyword(options.topicKeyword || '');
  const keyword = normalizeKeyword(options.keyword || '');
  const connectionIds = options.connectionId ? [options.connectionId] : listLogConnectionIds(logDir);
  const secMin = Math.floor(Math.max(startTime, -8640000000) / 1000);
  const secMax = Math.ceil(Math.min(endTime, 8640000000000) / 1000);
  const samples = [];

  for (const connectionId of connectionIds) {
    const files = listDayFiles(logDir, connectionId, true)
      .filter((filePath) => {
        const dayKey = path.basename(filePath, '.db');
        return dayEndTsFromKey(dayKey) >= startTime && dayStartTsFromKey(dayKey) <= endTime;
      });

    for (const filePath of files) {
      if (samples.length >= limit) break;
      const db = new Database(filePath, { readonly: true, fileMustExist: true });
      try {
        let sql = 'SELECT bucket_ts, topic, blob FROM buckets WHERE bucket_ts BETWEEN ? AND ?';
        const params = [secMin, secMax];
        if (topic) {
          sql += ' AND topic = ?';
          params.push(topic);
        }
        sql += ' ORDER BY bucket_ts DESC';
        const rows = db.prepare(sql).all(...params);
        for (const row of rows) {
          if (samples.length >= limit) break;
          if (topicKeyword && !normalizeKeyword(row.topic).includes(topicKeyword)) continue;
          const decoded = decodeBucket(row.blob, row.bucket_ts, row.topic, connectionId);
          for (let i = decoded.length - 1; i >= 0; i--) {
            const message = decoded[i];
            if (message.time < startTime || message.time > endTime) continue;
            if (keyword && !normalizeKeyword(message.topic + message.payload).includes(keyword)) continue;
            samples.push({
              time: message.time,
              localTime: formatLocalTime(message.time),
              topic: message.topic,
              payload: summarizePayload(message.payload, previewChars, fieldPaths)
            });
            if (samples.length >= limit) break;
          }
        }
      } finally {
        db.close();
      }
    }
  }

  samples.sort((a, b) => b.time - a.time);
  return {
    startTime,
    endTime,
    startLocalTime: formatLocalTime(startTime),
    endLocalTime: formatLocalTime(endTime),
    samples: samples.slice(0, limit)
  };
}

function readMessageStatus(logDir, options) {
  const now = Date.now();
  const endTime = Number.isFinite(options.endTime) ? options.endTime : now;
  const minutes = Math.min(1440, Math.max(1, options.minutes || DEFAULT_STATUS_MINUTES));
  const startTime = Number.isFinite(options.startTime) ? options.startTime : endTime - minutes * 60_000;
  const topic = options.topic && options.topic.trim() ? options.topic.trim() : null;
  const topicKeyword = normalizeKeyword(options.topicKeyword || '');
  const keyword = normalizeKeyword(options.keyword || '');
  const topicLimit = Math.min(50, Math.max(1, options.topicLimit || DEFAULT_STATUS_TOPIC_LIMIT));
  const sampleLimit = Math.min(10, Math.max(0, options.sampleLimit || 0));
  const payloadPreviewChars = Math.min(500, Math.max(0, options.payloadPreviewChars || 0));
  const connectionIds = options.connectionId ? [options.connectionId] : listLogConnectionIds(logDir);
  const secMin = Math.floor(Math.max(startTime, -8640000000) / 1000);
  const secMax = Math.ceil(Math.min(endTime, 8640000000000) / 1000);
  const topicStats = new Map();
  const samples = [];
  let total = 0;
  let latestTime = null;

  for (const connectionId of connectionIds) {
    const files = listDayFiles(logDir, connectionId, true)
      .filter((filePath) => {
        const dayKey = path.basename(filePath, '.db');
        return dayEndTsFromKey(dayKey) >= startTime && dayStartTsFromKey(dayKey) <= endTime;
      });

    for (const filePath of files) {
      const db = new Database(filePath, { readonly: true, fileMustExist: true });
      try {
        let sql = 'SELECT bucket_ts, topic, blob FROM buckets WHERE bucket_ts BETWEEN ? AND ?';
        const params = [secMin, secMax];
        if (topic) {
          sql += ' AND topic = ?';
          params.push(topic);
        }
        sql += ' ORDER BY bucket_ts DESC';
        const rows = db.prepare(sql).all(...params);
        for (const row of rows) {
          if (topicKeyword && !normalizeKeyword(row.topic).includes(topicKeyword)) continue;
          const decoded = decodeBucket(row.blob, row.bucket_ts, row.topic, connectionId);
          for (let i = decoded.length - 1; i >= 0; i--) {
            const message = decoded[i];
            if (message.time < startTime || message.time > endTime) continue;
            if (keyword && !normalizeKeyword(message.topic + message.payload).includes(keyword)) continue;

            total += 1;
            latestTime = latestTime === null ? message.time : Math.max(latestTime, message.time);
            const stat = topicStats.get(message.topic) || { topic: message.topic, count: 0, latestTime: message.time };
            stat.count += 1;
            stat.latestTime = Math.max(stat.latestTime, message.time);
            topicStats.set(message.topic, stat);
            if (samples.length < sampleLimit) {
              const sample = {
                time: message.time,
                localTime: formatLocalTime(message.time),
                topic: message.topic
              };
              const payloadPreview = previewPayload(message.payload, payloadPreviewChars);
              if (payloadPreview) sample.payloadPreview = payloadPreview;
              samples.push(sample);
            }
          }
        }
      } finally {
        db.close();
      }
    }
  }

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

function hasFtsIndex(db) {
  return getIndexMeta(db, 'fts5_enabled') === '1' && tableExists(db, 'history_messages_fts');
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
    conditions,
    terms,
    payloadMode,
    payloadPreviewChars: Math.min(2000, Math.max(0, Number.isFinite(options.payloadPreviewChars) ? Math.floor(options.payloadPreviewChars) : 300)),
    skipped: 0,
    out: []
  };
}

function acceptHistoryMessage(state, message, searchText) {
  const hay = searchText ?? normalizeKeyword(String(message.topic || '') + String(message.payload || ''));
  if (!matchesSearchText(hay, state.conditions, state.terms, state.keywordLogic)) return false;
  if (state.skipped < state.offset) {
    state.skipped += 1;
    return false;
  }
  state.out.push(message);
  return state.out.length >= state.limit;
}

function pushIndexedHistoryRow(db, connectionId, state, schemaVersion, row, bucketStmt, bucketCache) {
  const base = { connectionId, topic: row.topic, time: row.time_ms };
  const hasOffsets = hasOffsetIndexSchema(schemaVersion);
  const payloadLen = hasOffsets ? row.payload_len : undefined;
  if (hasOffsets && (state.payloadMode === 'none' || state.payloadMode === 'metadata')) {
    state.out.push(formatHistoryMessage(base, state, { payloadSize: payloadLen }));
    return state.out.length >= state.limit;
  }
  const bucket = bucketStmt.get(row.bucket_ts, row.topic);
  if (!bucket) return false;
  let payloadBytes = null;
  let payload = null;
  if (hasOffsets) {
    payloadBytes = readPayloadBytesSlice(bucket.blob, row.payload_offset ?? -1, row.payload_len ?? -1);
    if (state.payloadMode === 'full' && payloadBytes) payload = payloadBytes.toString('utf8');
  }
  if (!payloadBytes && payload == null) {
    const cacheKey = `${row.bucket_ts}|${row.topic}`;
    let decoded = bucketCache.get(cacheKey);
    if (!decoded) {
      decoded = decodeBucket(bucket.blob, row.bucket_ts, row.topic, connectionId);
      bucketCache.set(cacheKey, decoded);
    }
    payload = decoded[row.msg_index]?.payload ?? null;
  }
  if (!payloadBytes && payload == null) return false;
  state.out.push(formatHistoryMessage(base, state, { payloadBytes, payloadText: payload, payloadSize: payloadLen }));
  return state.out.length >= state.limit;
}

function queryFtsIndexedFile(db, connectionId, state, schemaVersion) {
  const match = buildFtsMatch(state.conditions, state.terms, state.keywordLogic);
  if (!match || !canUseFts(db, state)) return false;
  const hasOffsets = hasOffsetIndexSchema(schemaVersion);
  let sql = hasOffsets
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
  const params = [match, state.startTime, state.endTime];
  if (state.topic) {
    sql += ' AND m.topic = ?';
    params.push(state.topic);
  }
  const bucketStmt = db.prepare('SELECT blob FROM buckets WHERE bucket_ts = ? AND topic = ?');
  const bucketCache = new Map();
  let lastTime = null;
  let lastTopic = null;
  let lastMsgIndex = null;
  while (state.out.length < state.limit) {
    const pageSql = lastTime == null
      ? sql
      : `${sql}${state.order === 'asc'
          ? ' AND (m.time_ms > ? OR (m.time_ms = ? AND m.topic > ?) OR (m.time_ms = ? AND m.topic = ? AND m.msg_index > ?))'
          : ' AND (m.time_ms < ? OR (m.time_ms = ? AND m.topic < ?) OR (m.time_ms = ? AND m.topic = ? AND m.msg_index < ?))'}`;
    const pageParams = lastTime == null
      ? [...params]
      : [...params, lastTime, lastTime, lastTopic, lastTime, lastTopic, lastMsgIndex];
    const rows = db.prepare(`${pageSql}${state.order === 'asc'
      ? ' ORDER BY m.time_ms ASC, m.topic ASC, m.msg_index ASC LIMIT ?'
      : ' ORDER BY m.time_ms DESC, m.topic DESC, m.msg_index DESC LIMIT ?'}`).all(...pageParams, INDEX_QUERY_CHUNK_SIZE);
    if (!rows.length) break;
    for (const row of rows) {
      if (!matchesSearchText(rowSearchText(row), state.conditions, state.terms, state.keywordLogic)) continue;
      if (state.skipped < state.offset) {
        state.skipped += 1;
        continue;
      }
      if (pushIndexedHistoryRow(db, connectionId, state, schemaVersion, row, bucketStmt, bucketCache)) return true;
    }
    const tail = rows[rows.length - 1];
    lastTime = tail.time_ms;
    lastTopic = tail.topic;
    lastMsgIndex = tail.msg_index;
    if (rows.length < INDEX_QUERY_CHUNK_SIZE) break;
  }
  return true;
}

function queryIndexedFile(db, connectionId, state, schemaVersion) {
  const hasOffsets = hasOffsetIndexSchema(schemaVersion);
  let sql = hasOffsets
    ? 'SELECT bucket_ts, time_ms, topic, msg_index, search_text, payload_offset, payload_len FROM history_messages WHERE time_ms BETWEEN ? AND ?'
    : 'SELECT bucket_ts, time_ms, topic, msg_index, search_text FROM history_messages WHERE time_ms BETWEEN ? AND ?';
  const params = [state.startTime, state.endTime];
  const bucketStmt = db.prepare('SELECT blob FROM buckets WHERE bucket_ts = ? AND topic = ?');
  const bucketCache = new Map();
  if (state.topic) {
    sql += ' AND topic = ?';
    params.push(state.topic);
  }
  sql += state.order === 'asc'
    ? ' ORDER BY time_ms ASC, topic ASC, msg_index ASC'
    : ' ORDER BY time_ms DESC, topic DESC, msg_index DESC';
  sql += ' LIMIT ? OFFSET ?';

  let offset = 0;
  while (state.out.length < state.limit) {
    const rows = db.prepare(sql).all(...params, INDEX_QUERY_CHUNK_SIZE, offset);
    if (!rows.length) break;
    for (const row of rows) {
      if (!matchesSearchText(rowSearchText(row), state.conditions, state.terms, state.keywordLogic)) continue;
      if (state.skipped < state.offset) {
        state.skipped += 1;
        continue;
      }
      if (pushIndexedHistoryRow(db, connectionId, state, schemaVersion, row, bucketStmt, bucketCache)) return;
    }
    offset += rows.length;
    if (rows.length < INDEX_QUERY_CHUNK_SIZE) break;
  }
}

function queryBucketFile(db, connectionId, state) {
  const secMin = Math.floor(Math.max(state.startTime, -8640000000) / 1000);
  const secMax = Math.ceil(Math.min(state.endTime, 8640000000000) / 1000);
  let sql = 'SELECT bucket_ts, topic, blob FROM buckets WHERE bucket_ts BETWEEN ? AND ?';
  const params = [secMin, secMax];
  if (state.topic) {
    sql += ' AND topic = ?';
    params.push(state.topic);
  }
  sql += state.order === 'asc'
    ? ' ORDER BY bucket_ts ASC, topic ASC'
    : ' ORDER BY bucket_ts DESC, topic DESC';
  sql += ' LIMIT ? OFFSET ?';

  let offset = 0;
  while (state.out.length < state.limit) {
    const rows = db.prepare(sql).all(...params, BUCKET_QUERY_CHUNK_SIZE, offset);
    if (!rows.length) break;
    for (const row of rows) {
      const decoded = decodeBucket(row.blob, row.bucket_ts, row.topic, connectionId);
      const start = state.order === 'asc' ? 0 : decoded.length - 1;
      const end = state.order === 'asc' ? decoded.length : -1;
      const step = state.order === 'asc' ? 1 : -1;
      for (let i = start; i !== end; i += step) {
        const message = decoded[i];
        if (message.time < state.startTime || message.time > state.endTime) continue;
        const done = acceptHistoryMessage(
          state,
          formatHistoryMessage(
            { connectionId: message.connectionId, topic: message.topic, time: message.time },
            state,
            { payloadText: message.payload }
          ),
          normalizeKeyword(String(message.topic || '') + String(message.payload || ''))
        );
        if (done) return;
      }
    }
    offset += rows.length;
    if (rows.length < BUCKET_QUERY_CHUNK_SIZE) break;
  }
}

function queryHistory(logDir, options) {
  const state = buildQueryState(options);
  const connectionIds = options.connectionId
    ? [options.connectionId]
    : listLogConnectionIds(logDir);

  for (const connectionId of connectionIds) {
    if (state.out.length >= state.limit) break;
    const files = listDayFiles(logDir, connectionId, state.order !== 'asc')
      .filter((filePath) => {
        const dayKey = path.basename(filePath, '.db');
        return dayEndTsFromKey(dayKey) >= state.startTime && dayStartTsFromKey(dayKey) <= state.endTime;
      });

    for (const filePath of files) {
      if (state.out.length >= state.limit) break;
      const db = new Database(filePath, { readonly: true, fileMustExist: true });
      try {
        const indexSchemaVersion = getUsableIndexVersion(db);
        if (indexSchemaVersion) {
          const usedFts = queryFtsIndexedFile(db, connectionId, state, indexSchemaVersion);
          if (!usedFts) queryIndexedFile(db, connectionId, state, indexSchemaVersion);
        } else {
          queryBucketFile(db, connectionId, state);
        }
      } finally {
        db.close();
      }
    }
  }

  return state.out;
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
        limit: z.number().int().min(1).max(MAX_LIMIT).default(100)
      })
    },
    async (input) => {
      const connectionId = resolveConnectionId(userDataDir, logDir, input);
      if (!connectionId) throw new Error('connectionId or connectionName is required.');
      return jsonText({
        logDir,
        connectionId,
        connectionName: input.connectionName,
        topic: input.topic,
        messages: readRecentMessages(logDir, connectionId, input.limit, input.topic)
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
        sampleLimit: z.number().int().min(0).max(10).default(0).describe('Number of recent sample messages to include. Defaults to 0 to save tokens.'),
        payloadPreviewChars: z.number().int().min(0).max(500).default(0).describe('Payload preview length for samples. Defaults to 0 to save tokens.')
      })
    },
    async (input) => {
      const connectionId = resolveConnectionId(userDataDir, logDir, input);
      const query = connectionId ? { ...input, connectionId } : input;
      return jsonText({
        connectionId,
        connectionName: input.connectionName,
        connectionKeyword: input.connectionKeyword,
        status: readMessageStatus(logDir, query)
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
        payloadFields: z.array(z.string()).optional().describe('Extra JSON field paths to extract, for example ["data.battery","data.mode_code"].')
      })
    },
    async (input) => {
      const connectionId = resolveConnectionId(userDataDir, logDir, input);
      const query = connectionId ? { ...input, connectionId } : input;
      return jsonText({
        connectionId,
        connectionName: input.connectionName,
        connectionKeyword: input.connectionKeyword,
        result: readPayloadSamples(logDir, query)
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
        connectionKeyword: z.string().optional().describe('Fuzzy connection keyword, for example "深圳星扬" or "xingyang-szga".')
      })
    },
    async (input) => {
      const connectionId = resolveConnectionId(userDataDir, logDir, input);
      const query = connectionId ? { ...input, connectionId } : input;
      return jsonText({
        logDir,
        connectionId,
        connectionName: input.connectionName,
        connectionKeyword: input.connectionKeyword,
        status: readHistoryIndexStatus(logDir, query)
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
        limit: z.number().int().min(1).max(MAX_LIMIT).default(200)
      })
    },
    async (input) => {
      const connectionId = resolveConnectionId(userDataDir, logDir, input);
      const query = connectionId ? { ...input, connectionId } : input;
      return jsonText({
        logDir,
        query,
        messages: queryHistory(logDir, query)
      });
    }
  );

  const transport = new StdioServerTransport();
  installStdioExitHandlers(transport);
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`[mqttmountain-mcp] ${error?.stack || error}\n`);
  process.exit(1);
});
