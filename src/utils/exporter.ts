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

/** MQTTX 兼容的单文件 JSON（字段：Receive Time / Topic / Payload / QoS / Retain） */
export function exportMqttxJson(rows: { topic: string; payload: string; time: number }[], filename: string): void {
    const list = rows.map((r) => ({
        createAt: r.time,
        Topic: r.topic,
        Payload: r.payload,
        QoS: 0,
        Retain: false
    }));
    const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json;charset=utf-8' });
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
    for (const [topic, arr] of groups) {
        const safe = topic.replace(/[\\/:*?"<>|]/g, '_');
        zip.file(`${safe || 'root'}.jsonl`, arr.join('\n'));
    }
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    triggerDownload(blob, filename);
}

export type ExportRow = MqttMessage | HistoryMessage;
