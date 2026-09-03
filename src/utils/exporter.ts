import JSZip from 'jszip';
import type { HistoryMessage, MqttMessage } from '@shared/types';

function triggerDownload(blob: Blob, filename: string): void {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function shortHash(value: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

export function buildUniqueTopicEntryNames(topics: Iterable<string>): Map<string, string> {
    const result = new Map<string, string>();
    const used = new Set<string>();
    for (const topic of topics) {
        let base = topic.replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/u, '').slice(0, 120) || 'root';
        let name = `${base}.jsonl`;
        let key = name.toLowerCase();
        if (used.has(key)) {
            const suffix = `-${shortHash(topic)}`;
            base = base.slice(0, Math.max(1, 120 - suffix.length)) + suffix;
            name = `${base}.jsonl`;
            key = name.toLowerCase();
            let index = 2;
            while (used.has(key)) {
                name = `${base}-${index++}.jsonl`;
                key = name.toLowerCase();
            }
        }
        used.add(key);
        result.set(topic, name);
    }
    return result;
}

/** MQTTX 兼容的单文件 JSON（字段：Receive Time / Topic / Payload / QoS / Retain） */
export function exportMqttxJson(rows: { topic: string; payload: string; time: number }[], filename: string): void {
    const list = rows.map((r) => ({
        createAt: r.time,
        Topic: r.topic,
        Payload: r.payload,
        QoS: 0,
        Retain: false
    }));
    const blob = new Blob([JSON.stringify(list)], { type: 'application/json;charset=utf-8' });
    triggerDownload(blob, filename);
}

/** 分组 ZIP：每主题一个 .jsonl，仅 {time, topic, payload} */
export async function exportGroupedZip(rows: { topic: string; payload: string; time: number }[], filename: string): Promise<void> {
    const zip = new JSZip();
    const groups = new Map<string, string[]>();
    for (const r of rows) {
        const line = JSON.stringify({ time: r.time, topic: r.topic, payload: r.payload });
        let arr = groups.get(r.topic);
        if (!arr) { arr = []; groups.set(r.topic, arr); }
        arr.push(line);
    }
    const entryNames = buildUniqueTopicEntryNames(groups.keys());
    for (const [topic, arr] of groups) {
        zip.file(entryNames.get(topic)!, arr.join('\n'));
    }
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    triggerDownload(blob, filename);
}

export type ExportRow = MqttMessage | HistoryMessage;
