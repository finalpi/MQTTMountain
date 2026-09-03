export type PayloadEncoding = 'utf8' | 'binary' | 'invalid-utf8';

export interface PayloadView {
    text: string;
    size: number;
    encoding: PayloadEncoding;
    base64?: string;
}

// Keep a leading UTF-8 BOM in the decoded string so valid UTF-8 payloads can be
// reconstructed byte-for-byte without also cloning their Buffer to the worker.
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function decodePayloadView(payload: Buffer): PayloadView {
    const size = payload.length;
    try {
        return {
            text: utf8Decoder.decode(payload),
            size,
            encoding: 'utf8'
        };
    } catch {
        return {
            text: payload.toString('utf8'),
            size,
            encoding: 'invalid-utf8',
            base64: payload.toString('base64')
        };
    }
}

export function payloadBytes(payload: string | Buffer | Uint8Array): Buffer {
    if (Buffer.isBuffer(payload)) return payload;
    if (payload instanceof Uint8Array) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
    return Buffer.from(payload, 'utf8');
}
