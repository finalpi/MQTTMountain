import type { HistoryMessage } from '../../shared/types';

export interface BucketItem {
    payload: string;
    tsMs: number;
}

export interface ExistingBucketRow {
    blob: Buffer;
    count: number;
    bytes: number;
}

export interface BucketValidationResult {
    valid: boolean;
    structureValid: boolean;
    count: number;
    reason?: string;
}

export interface BucketEntry {
    msgIndex: number;
    time: number;
    payload: string;
    entryOffset: number;
    payloadOffset: number;
    payloadLen: number;
    entryLen: number;
}

/** 编码：[u32 count][u16 offset_ms][u32 payload_len][payload_utf8]... */
export function encodeBucketEntries(items: BucketItem[], bucketSec: number): Buffer {
    const base = bucketSec * 1000;
    const buffers: Buffer[] = [];
    for (const it of items) {
        const off = Math.max(0, Math.min(65535, it.tsMs - base));
        const data = Buffer.from(it.payload, 'utf8');
        const meta = Buffer.alloc(6);
        meta.writeUInt16LE(off, 0);
        meta.writeUInt32LE(data.length, 2);
        buffers.push(meta, data);
    }
    return Buffer.concat(buffers);
}

export function encodeBucket(items: BucketItem[], bucketSec: number): Buffer {
    const head = Buffer.alloc(4);
    head.writeUInt32LE(items.length, 0);
    return Buffer.concat([head, encodeBucketEntries(items, bucketSec)]);
}

export function validateBucketBlob(blob: unknown, expectedCount: number, expectedBytes: number): BucketValidationResult {
    if (!Buffer.isBuffer(blob)) return { valid: false, structureValid: false, count: 0, reason: 'blob is not a Buffer' };
    if (blob.length < 4) return { valid: false, structureValid: false, count: 0, reason: 'blob is shorter than header' };
    const count = blob.readUInt32LE(0);
    let p = 4;
    for (let i = 0; i < count; i++) {
        if (p + 6 > blob.length) return { valid: false, structureValid: false, count, reason: 'truncated entry header' };
        p += 2;
        const len = blob.readUInt32LE(p); p += 4;
        if (p + len > blob.length) return { valid: false, structureValid: false, count, reason: 'truncated payload' };
        p += len;
    }
    if (p !== blob.length) return { valid: false, structureValid: false, count, reason: 'trailing bytes after entries' };
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) return { valid: false, structureValid: true, count, reason: 'invalid bucket count metadata' };
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes !== blob.length) return { valid: false, structureValid: true, count, reason: 'bucket bytes metadata mismatch' };
    if (count !== expectedCount) return { valid: false, structureValid: true, count, reason: 'bucket count metadata mismatch' };
    return { valid: true, structureValid: true, count };
}

export function appendEntriesToBucketBlob(existingBlob: Buffer, existingCount: number, newItems: BucketItem[], bucketSec: number): { blob: Buffer; count: number; bytes: number } {
    const count = existingCount + newItems.length;
    if (count > 0xFFFFFFFF) throw new Error('bucket message count exceeds uint32 limit');
    const tail = encodeBucketEntries(newItems, bucketSec);
    const blob = Buffer.concat([existingBlob, tail], existingBlob.length + tail.length);
    blob.writeUInt32LE(count, 0);
    return { blob, count, bytes: blob.length };
}

export function iterateBucketEntries(blob: Buffer, bucketSec: number): BucketEntry[] {
    const out: BucketEntry[] = [];
    if (!blob || blob.length < 4) return out;
    const base = bucketSec * 1000;
    const n = blob.readUInt32LE(0);
    let p = 4;
    for (let i = 0; i < n && p + 6 <= blob.length; i++) {
        const entryOffset = p;
        const off = blob.readUInt16LE(p); p += 2;
        const payloadLen = blob.readUInt32LE(p); p += 4;
        const payloadOffset = p;
        if (payloadOffset + payloadLen > blob.length) break;
        const payload = blob.subarray(payloadOffset, payloadOffset + payloadLen).toString('utf8');
        p += payloadLen;
        out.push({
            msgIndex: i,
            time: base + off,
            payload,
            entryOffset,
            payloadOffset,
            payloadLen,
            entryLen: p - entryOffset
        });
    }
    return out;
}

export function readPayloadSlice(blob: Buffer, payloadOffset: number, payloadLen: number): string | null {
    if (!Buffer.isBuffer(blob)) return null;
    if (!Number.isSafeInteger(payloadOffset) || !Number.isSafeInteger(payloadLen)) return null;
    if (payloadOffset < 4 || payloadLen < 0 || payloadOffset + payloadLen > blob.length) return null;
    return blob.subarray(payloadOffset, payloadOffset + payloadLen).toString('utf8');
}

export function decodeBucket(blob: Buffer, bucketSec: number, topic: string): HistoryMessage[] {
    return iterateBucketEntries(blob, bucketSec).map((entry) => ({
        connectionId: '',
        topic,
        payload: entry.payload,
        time: entry.time
    }));
}
