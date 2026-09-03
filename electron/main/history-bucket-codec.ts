import type { HistoryMessage } from '../../shared/types';
import { decodePayloadView, payloadBytes } from './payload-codec';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const COMPRESSED_BUCKET_MAGIC = Buffer.from('MMZ1');
const COMPRESSED_BUCKET_HEADER_BYTES = 8;
const MIN_COMPRESSION_SAVINGS = 16;

export interface BucketItem {
    payload: string;
    payloadBytes?: Buffer | Uint8Array;
    payloadSize?: number;
    payloadEncoding?: 'utf8' | 'binary' | 'invalid-utf8';
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
    payloadSize: number;
    payloadEncoding: 'utf8' | 'binary' | 'invalid-utf8';
    payloadBase64?: string;
}

export function isCompressedBucketBlob(blob: unknown): boolean {
    return Buffer.isBuffer(blob)
        && blob.length >= COMPRESSED_BUCKET_HEADER_BYTES
        && blob.subarray(0, COMPRESSED_BUCKET_MAGIC.length).equals(COMPRESSED_BUCKET_MAGIC);
}

export function unpackBucketBlob(blob: Buffer): Buffer {
    if (!isCompressedBucketBlob(blob)) return blob;
    const expectedLength = blob.readUInt32LE(4);
    const raw = inflateRawSync(blob.subarray(COMPRESSED_BUCKET_HEADER_BYTES));
    if (raw.length !== expectedLength) throw new Error(`compressed bucket length mismatch: expected ${expectedLength}, got ${raw.length}`);
    return raw;
}

export function bucketUncompressedBytes(blob: Buffer): number {
    return isCompressedBucketBlob(blob) ? blob.readUInt32LE(4) : blob.length;
}

export function packBucketBlob(raw: Buffer): Buffer {
    if (raw.length === 0) return raw;
    const compressed = deflateRawSync(raw, { level: 1 });
    if (compressed.length + COMPRESSED_BUCKET_HEADER_BYTES + MIN_COMPRESSION_SAVINGS >= raw.length) return raw;
    const header = Buffer.allocUnsafe(COMPRESSED_BUCKET_HEADER_BYTES);
    COMPRESSED_BUCKET_MAGIC.copy(header, 0);
    header.writeUInt32LE(raw.length, 4);
    return Buffer.concat([header, compressed], header.length + compressed.length);
}

/** 编码：[u32 count][u16 offset_ms][u32 payload_len][payload_utf8]... */
export function encodeBucketEntries(items: BucketItem[], bucketSec: number): Buffer {
    const base = bucketSec * 1000;
    const buffers: Buffer[] = [];
    for (const it of items) {
        const off = Math.max(0, Math.min(65535, it.tsMs - base));
        const data = it.payloadBytes ? payloadBytes(it.payloadBytes) : Buffer.from(it.payload, 'utf8');
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
    return packBucketBlob(Buffer.concat([head, encodeBucketEntries(items, bucketSec)]));
}

export function validateBucketBlob(blob: unknown, expectedCount: number, expectedBytes: number): BucketValidationResult {
    if (!Buffer.isBuffer(blob)) return { valid: false, structureValid: false, count: 0, reason: 'blob is not a Buffer' };
    const bytesMetadataValid = Number.isSafeInteger(expectedBytes) && expectedBytes === blob.length;
    let raw: Buffer;
    try {
        raw = unpackBucketBlob(blob);
    } catch (error) {
        return { valid: false, structureValid: false, count: 0, reason: (error as Error).message || 'bucket decompression failed' };
    }
    if (raw.length < 4) return { valid: false, structureValid: false, count: 0, reason: 'blob is shorter than header' };
    const count = raw.readUInt32LE(0);
    let p = 4;
    for (let i = 0; i < count; i++) {
        if (p + 6 > raw.length) return { valid: false, structureValid: false, count, reason: 'truncated entry header' };
        p += 2;
        const len = raw.readUInt32LE(p); p += 4;
        if (p + len > raw.length) return { valid: false, structureValid: false, count, reason: 'truncated payload' };
        p += len;
    }
    if (p !== raw.length) return { valid: false, structureValid: false, count, reason: 'trailing bytes after entries' };
    if (!bytesMetadataValid) return { valid: false, structureValid: true, count, reason: 'bucket bytes metadata mismatch' };
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) return { valid: false, structureValid: true, count, reason: 'invalid bucket count metadata' };
    if (count !== expectedCount) return { valid: false, structureValid: true, count, reason: 'bucket count metadata mismatch' };
    return { valid: true, structureValid: true, count };
}

export function appendEntriesToBucketBlob(existingBlob: Buffer, existingCount: number, newItems: BucketItem[], bucketSec: number): { blob: Buffer; count: number; bytes: number } {
    const count = existingCount + newItems.length;
    if (count > 0xFFFFFFFF) throw new Error('bucket message count exceeds uint32 limit');
    const tail = encodeBucketEntries(newItems, bucketSec);
    const existingRaw = unpackBucketBlob(existingBlob);
    const raw = Buffer.concat([existingRaw, tail], existingRaw.length + tail.length);
    raw.writeUInt32LE(count, 0);
    const blob = packBucketBlob(raw);
    return { blob, count, bytes: blob.length };
}

export function iterateBucketEntries(blob: Buffer, bucketSec: number, startIndex = 0): BucketEntry[] {
    const out: BucketEntry[] = [];
    if (!blob) return out;
    const raw = unpackBucketBlob(blob);
    if (raw.length < 4) return out;
    const base = bucketSec * 1000;
    const n = raw.readUInt32LE(0);
    const firstIndex = Math.max(0, startIndex | 0);
    let p = 4;
    for (let i = 0; i < n && p + 6 <= raw.length; i++) {
        const entryOffset = p;
        const off = raw.readUInt16LE(p); p += 2;
        const payloadLen = raw.readUInt32LE(p); p += 4;
        const payloadOffset = p;
        if (payloadOffset + payloadLen > raw.length) break;
        p += payloadLen;
        if (i < firstIndex) continue;
        const payloadView = decodePayloadView(raw.subarray(payloadOffset, payloadOffset + payloadLen));
        out.push({
            msgIndex: i,
            time: base + off,
            payload: payloadView.text,
            entryOffset,
            payloadOffset,
            payloadLen,
            entryLen: p - entryOffset,
            payloadSize: payloadView.size,
            payloadEncoding: payloadView.encoding,
            payloadBase64: payloadView.base64
        });
    }
    return out;
}

export function readPayloadBytesSlice(blob: Buffer, payloadOffset: number, payloadLen: number): Buffer | null {
    if (!Buffer.isBuffer(blob)) return null;
    // Compressed buckets are decoded once through the caller's bucket cache.
    if (isCompressedBucketBlob(blob)) return null;
    if (!Number.isSafeInteger(payloadOffset) || !Number.isSafeInteger(payloadLen)) return null;
    if (payloadOffset < 4 || payloadLen < 0 || payloadOffset + payloadLen > blob.length) return null;
    return blob.subarray(payloadOffset, payloadOffset + payloadLen);
}

export function readPayloadSlice(blob: Buffer, payloadOffset: number, payloadLen: number): string | null {
    return readPayloadBytesSlice(blob, payloadOffset, payloadLen)?.toString('utf8') ?? null;
}

export function decodeBucket(blob: Buffer, bucketSec: number, topic: string): HistoryMessage[] {
    return iterateBucketEntries(blob, bucketSec).map((entry) => ({
        connectionId: '',
        topic,
        payload: entry.payload,
        time: entry.time,
        payloadSize: entry.payloadSize,
        payloadEncoding: entry.payloadEncoding,
        payloadBase64: entry.payloadBase64
    }));
}
