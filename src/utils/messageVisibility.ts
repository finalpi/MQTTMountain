export interface TimestampedTopicRow {
    topic: string;
    time: number;
}

export function isRowAfterClear(
    row: TimestampedTopicRow,
    displayClearedAt: number,
    topicClearedAt = 0
): boolean {
    return row.time > displayClearedAt && row.time > topicClearedAt;
}

export function filterRowsAfterClear<T extends TimestampedTopicRow>(
    rows: readonly T[],
    displayClearedAt: number,
    topicClearTimes: ReadonlyMap<string, number>
): T[] {
    return rows.filter((row) => isRowAfterClear(
        row,
        displayClearedAt,
        topicClearTimes.get(row.topic) ?? 0
    ));
}
