import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import type {
    HistoryExportProgress,
    HistoryExportRequest,
    HistoryExportResult,
    HistoryKeywordCondition,
    HistoryMessage
} from '../../shared/types';
import { decodeBucket } from './history-bucket-codec';
import { collectDayFiles as collectHistoryDayFiles, normalizeKeyword } from './history-query-common';

const port = parentPort;

interface ExportWorkerData {
    req: HistoryExportRequest;
    targetPath: string;
    logRoot: string;
}

const { req, targetPath, logRoot } = workerData as ExportWorkerData;

function matchesConditions(row: HistoryMessage, conditions: HistoryKeywordCondition[]): boolean {
    const active = conditions
        .map((item) => ({ join: item.join, term: normalizeKeyword(item.term) }))
        .filter((item) => item.term);
    if (active.length === 0) return true;
    const hay = normalizeKeyword(row.topic + row.payload);
    let result = hay.includes(active[0].term);
    for (let i = 1; i < active.length; i++) {
        const item = active[i];
        const hit = hay.includes(item.term);
        if (item.join === 'or') result = result || hit;
        else if (item.join === 'not') result = result && !hit;
        else result = result && hit;
    }
    return result;
}

function sendProgress(progress: HistoryExportProgress): void {
    port?.postMessage({ type: 'progress', progress });
}

function sendDone(result: HistoryExportResult): void {
    port?.postMessage({ type: 'done', result });
}

function sendError(error: unknown, processed: number, written: number, total = 0): void {
    sendProgress({
        stage: 'error',
        processed,
        written,
        total,
        percent: 100,
        message: (error as Error).message || '导出失败',
        format: req.format
    });
    port?.postMessage({ type: 'error', error: (error as Error).message || '导出失败' });
}

function collectDayFiles(): { path: string; san: string; dk: string }[] {
    return collectHistoryDayFiles(logRoot, {
        connectionId: req.query.connectionId,
        startTime: req.query.startTime,
        endTime: req.query.endTime,
        order: 'desc'
    });
}

function estimateTotal(files: { path: string }[]): number {
    const st = req.query.startTime != null && req.query.startTime > 0 ? req.query.startTime : -8640000000000000;
    const et = req.query.endTime != null && req.query.endTime > 0 ? req.query.endTime : 8640000000000000;
    const secMin = Math.floor(Math.max(st, -8640000000) / 1000);
    const secMax = Math.ceil(Math.min(et, 8640000000000) / 1000);
    const topicFilter = req.query.topic && req.query.topic.trim() ? req.query.topic.trim() : null;
    let total = 0;

    for (const file of files) {
        const db = new Database(file.path, { readonly: true });
        try {
            let sql = 'SELECT SUM(count) as total FROM buckets WHERE bucket_ts BETWEEN ? AND ?';
            const params: Array<number | string> = [secMin, secMax];
            if (topicFilter) {
                sql += ' AND topic = ?';
                params.push(topicFilter);
            }
            const row = db.prepare(sql).get(...params) as { total?: number | null } | undefined;
            total += row?.total ?? 0;
        } finally {
            db.close();
        }
    }
    return total;
}

function calcPercent(processed: number, total: number, stage: HistoryExportProgress['stage']): number {
    if (stage === 'packaging') return 98;
    if (stage === 'done') return 100;
    if (total <= 0) return 0;
    return Math.max(0, Math.min(97, Math.round((processed / total) * 97)));
}

async function waitForDrain(stream: fs.WriteStream): Promise<void> {
    await new Promise<void>((resolve) => stream.once('drain', resolve));
}

async function finalizeWriteStream(stream: fs.WriteStream): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        stream.end(() => resolve());
        stream.once('error', reject);
    });
}

function sanitizeTopicFilename(topic: string): string {
    const safe = topic.replace(/[\\/:*?"<>|]/g, '_').trim();
    return safe || 'root';
}

function emitTick(stage: HistoryExportProgress['stage'], processed: number, written: number, total: number, startedAt: number, message: string): void {
    const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
    sendProgress({
        stage,
        processed,
        written,
        total,
        percent: calcPercent(processed, total, stage),
        rate: processed / elapsedSec,
        format: req.format,
        message
    });
}

async function exportJson(files: { path: string; san: string }[], total: number, startedAt: number): Promise<HistoryExportResult> {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const stream = fs.createWriteStream(targetPath, { encoding: 'utf8' });
    const st = req.query.startTime != null && req.query.startTime > 0 ? req.query.startTime : -8640000000000000;
    const et = req.query.endTime != null && req.query.endTime > 0 ? req.query.endTime : 8640000000000000;
    const secMin = Math.floor(Math.max(st, -8640000000) / 1000);
    const secMax = Math.ceil(Math.min(et, 8640000000000) / 1000);
    const topicFilter = req.query.topic && req.query.topic.trim() ? req.query.topic.trim() : null;
    let processed = 0;
    let written = 0;
    let first = true;
    let lastReport = 0;

    stream.write('[', 'utf8');

    for (const file of files) {
        const db = new Database(file.path, { readonly: true });
        try {
            let sql = 'SELECT bucket_ts, topic, blob FROM buckets WHERE bucket_ts BETWEEN ? AND ?';
            const params: Array<number | string> = [secMin, secMax];
            if (topicFilter) {
                sql += ' AND topic = ?';
                params.push(topicFilter);
            }
            sql += ' ORDER BY bucket_ts DESC, topic DESC';
            const rows = db.prepare(sql).iterate(...params) as Iterable<{ bucket_ts: number; topic: string; blob: Buffer }>;
            for (const row of rows) {
                const decoded = decodeBucket(row.blob, row.bucket_ts, row.topic);
                for (let i = decoded.length - 1; i >= 0; i--) {
                    const item = decoded[i];
                    if (item.time < st || item.time > et) continue;
                    item.connectionId = file.san;
                    processed++;
                    if (matchesConditions(item, req.conditions)) {
                        const chunk = `${first ? '' : ','}${JSON.stringify({
                            createAt: item.time,
                            Topic: item.topic,
                            Payload: item.payload,
                            QoS: 0,
                            Retain: false
                        })}`;
                        if (!stream.write(chunk, 'utf8')) await waitForDrain(stream);
                        first = false;
                        written++;
                    }
                    if (processed - lastReport >= 2000) {
                        lastReport = processed;
                        emitTick('writing', processed, written, total, startedAt, `正在导出 JSON：${Math.min(100, calcPercent(processed, total, 'writing'))}%`);
                    }
                }
            }
        } finally {
            db.close();
        }
    }

    stream.write(']', 'utf8');
    await finalizeWriteStream(stream);

    return {
        filePath: targetPath,
        dirPath: path.dirname(targetPath),
        format: 'json',
        totalRows: written
    };
}

async function exportZip(files: { path: string; san: string }[], total: number, stagingDir: string, startedAt: number): Promise<HistoryExportResult> {
    const tempDataDir = stagingDir;
    fs.mkdirSync(tempDataDir, { recursive: true });

    const topicStreams = new Map<string, fs.WriteStream>();
    const topicFiles = new Map<string, string>();
    const fileNameByTopic = new Map<string, string>();
    const st = req.query.startTime != null && req.query.startTime > 0 ? req.query.startTime : -8640000000000000;
    const et = req.query.endTime != null && req.query.endTime > 0 ? req.query.endTime : 8640000000000000;
    const secMin = Math.floor(Math.max(st, -8640000000) / 1000);
    const secMax = Math.ceil(Math.min(et, 8640000000000) / 1000);
    const topicFilter = req.query.topic && req.query.topic.trim() ? req.query.topic.trim() : null;
    let processed = 0;
    let written = 0;
    let lastReport = 0;

    const getTopicStream = (topic: string): fs.WriteStream => {
        let stream = topicStreams.get(topic);
        if (stream) return stream;
        const safeName = sanitizeTopicFilename(topic);
        let candidate = safeName;
        let index = 1;
        while (topicFiles.has(candidate)) {
            index++;
            candidate = `${safeName}-${index}`;
        }
        const topicPath = path.join(tempDataDir, `${candidate}.jsonl`);
        stream = fs.createWriteStream(topicPath, { encoding: 'utf8' });
        topicStreams.set(topic, stream);
        topicFiles.set(candidate, topicPath);
        fileNameByTopic.set(topic, candidate);
        return stream;
    };

    for (const file of files) {
        const db = new Database(file.path, { readonly: true });
        try {
            let sql = 'SELECT bucket_ts, topic, blob FROM buckets WHERE bucket_ts BETWEEN ? AND ?';
            const params: Array<number | string> = [secMin, secMax];
            if (topicFilter) {
                sql += ' AND topic = ?';
                params.push(topicFilter);
            }
            sql += ' ORDER BY bucket_ts DESC, topic DESC';
            const rows = db.prepare(sql).iterate(...params) as Iterable<{ bucket_ts: number; topic: string; blob: Buffer }>;
            for (const row of rows) {
                const decoded = decodeBucket(row.blob, row.bucket_ts, row.topic);
                for (let i = decoded.length - 1; i >= 0; i--) {
                    const item = decoded[i];
                    if (item.time < st || item.time > et) continue;
                    item.connectionId = file.san;
                    processed++;
                    if (matchesConditions(item, req.conditions)) {
                        const stream = getTopicStream(item.topic);
                        const line = `${JSON.stringify({ time: item.time, topic: item.topic, payload: item.payload })}\n`;
                        if (!stream.write(line, 'utf8')) await waitForDrain(stream);
                        written++;
                    }
                    if (processed - lastReport >= 2000) {
                        lastReport = processed;
                        emitTick('writing', processed, written, total, startedAt, `正在写入分片：${Math.min(100, calcPercent(processed, total, 'writing'))}%`);
                    }
                }
            }
        } finally {
            db.close();
        }
    }

    for (const stream of topicStreams.values()) {
        await finalizeWriteStream(stream);
    }

    emitTick('packaging', processed, written, total, startedAt, '正在打包 ZIP...');

    const zip = new JSZip();
    for (const [name, filePath] of topicFiles) {
        zip.file(`${name}.jsonl`, fs.createReadStream(filePath));
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(targetPath);
        out.once('finish', resolve);
        out.once('error', reject);
        zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 4 } })
            .once('error', reject)
            .pipe(out);
    });

    return {
        filePath: targetPath,
        dirPath: path.dirname(targetPath),
        format: 'zip',
        totalRows: written
    };
}

async function main(): Promise<void> {
    const startedAt = Date.now();
    const targetDir = path.dirname(targetPath);
    const targetBase = path.basename(targetPath, path.extname(targetPath));
    const stagingDir = path.join(targetDir, `.${targetBase}.zip.parts`);
    let processed = 0;
    let written = 0;

    try {
        sendProgress({
            stage: 'preparing',
            processed,
            written,
            percent: 0,
            total: 0,
            format: req.format,
            message: '正在统计导出范围...'
        });

        const files = collectDayFiles();
        const total = estimateTotal(files);
        sendProgress({
            stage: 'preparing',
            processed,
            written,
            total,
            percent: total > 0 ? 1 : 0,
            format: req.format,
            message: total > 0 ? `待扫描 ${total.toLocaleString()} 条候选消息` : '未找到可导出的候选消息'
        });

        const result = req.format === 'json'
            ? await exportJson(files, total, startedAt)
            : await exportZip(files, total, stagingDir, startedAt);

        processed = result.totalRows;
        written = result.totalRows;
        sendDone(result);
    } catch (error) {
        sendError(error, processed, written);
    } finally {
        try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    }
}

void main();
