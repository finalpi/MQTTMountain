export function formatTime(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function shortTime(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function prettyJson(s: string): string {
    try {
        const parsed = JSON.parse(s);
        return JSON.stringify(parsed, null, 2);
    } catch {
        return s;
    }
}

export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function randomClientId(): string {
    return 'mqttx_' + Math.random().toString(16).slice(2, 10);
}

export function randomId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** datetime-local 值 <-> ms */
export function tsToDatetimeLocal(ts: number): string {
    if (!ts || ts <= 0) return '';
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function datetimeLocalToTs(s: string): number {
    if (!s) return 0;
    const t = new Date(s).getTime();
    return Number.isFinite(t) ? t : 0;
}
