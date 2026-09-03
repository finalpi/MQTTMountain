export interface SequencedRow {
    seq: number;
}

export interface ReadonlyIndexedBuffer<T> {
    length: number;
    at(index: number): T | undefined;
}

export interface IncrementalSnapshot<T> {
    rows: T[];
    mode: 'full' | 'delta';
    oldestSeq: number | null;
    latestSeq: number | null;
}

export function buildIncrementalSnapshot<T extends SequencedRow>(
    buffer: ReadonlyIndexedBuffer<T>,
    limit: number,
    currentEpoch: number,
    requestedEpoch?: number,
    afterSeq?: number
): IncrementalSnapshot<T> {
    const oldestSeq = buffer.at(0)?.seq ?? null;
    const canDelta = Number.isFinite(afterSeq) && requestedEpoch === currentEpoch && limit > 0;
    if (canDelta) {
        const reversed: T[] = [];
        let foundBoundary = false;
        let latestSeq = afterSeq as number;
        for (let i = buffer.length - 1; i >= 0; i--) {
            const row = buffer.at(i);
            if (!row) continue;
            if (row.seq <= (afterSeq as number)) {
                foundBoundary = true;
                break;
            }
            reversed.push(row);
            latestSeq = Math.max(latestSeq, row.seq);
            if (reversed.length > limit) break;
        }
        if (foundBoundary && reversed.length <= limit) {
            return { rows: reversed.reverse(), mode: 'delta', oldestSeq, latestSeq };
        }
    }

    const start = Math.max(0, buffer.length - limit);
    const rows: T[] = [];
    let latestSeq: number | null = null;
    for (let i = start; i < buffer.length; i++) {
        const row = buffer.at(i);
        if (!row) continue;
        rows.push(row);
        latestSeq = latestSeq == null ? row.seq : Math.max(latestSeq, row.seq);
    }
    return { rows, mode: 'full', oldestSeq, latestSeq };
}
