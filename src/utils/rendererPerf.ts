interface PerfAggregate {
    calls: number;
    totalMs: number;
    maxMs: number;
    units: number;
}

const aggregates = new Map<string, PerfAggregate>();
let lastFlushAt = typeof performance !== 'undefined' ? performance.now() : 0;
const FLUSH_INTERVAL_MS = 60_000;

export function recordRendererPerf(name: string, durationMs: number, units = 0): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const current = aggregates.get(name) ?? { calls: 0, totalMs: 0, maxMs: 0, units: 0 };
    current.calls++;
    current.totalMs += durationMs;
    current.maxMs = Math.max(current.maxMs, durationMs);
    current.units += Math.max(0, units);
    aggregates.set(name, current);

    const now = performance.now();
    if (now - lastFlushAt < FLUSH_INTERVAL_MS) return;
    lastFlushAt = now;
    const metrics: Record<string, { calls: number; totalMs: number; avgMs: number; maxMs: number; units: number; avgUnits: number }> = {};
    for (const [key, value] of aggregates) {
        metrics[key] = {
            calls: value.calls,
            totalMs: Number(value.totalMs.toFixed(2)),
            avgMs: Number((value.totalMs / Math.max(1, value.calls)).toFixed(3)),
            maxMs: Number(value.maxMs.toFixed(2)),
            units: value.units,
            avgUnits: Math.round(value.units / Math.max(1, value.calls))
        };
    }
    aggregates.clear();
    console.info(`[renderer-diagnostics] ${JSON.stringify({ event: 'renderer-performance', metrics })}`);
}
