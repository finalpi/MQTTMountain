export interface HydrationIdentity {
    topic: string;
    payload: string;
    time: number;
}

type PayloadCounts = Map<string, number>;
type TopicCounts = Map<string, PayloadCounts>;

export interface HydrationCreditLedger {
    cutoff: number;
    counts: Map<number, TopicCounts>;
}

export function createHydrationCredits(cutoff: number, rows: readonly HydrationIdentity[]): HydrationCreditLedger {
    const ledger: HydrationCreditLedger = { cutoff, counts: new Map() };
    for (const row of rows) {
        let byTopic = ledger.counts.get(row.time);
        if (!byTopic) ledger.counts.set(row.time, byTopic = new Map());
        let byPayload = byTopic.get(row.topic);
        if (!byPayload) byTopic.set(row.topic, byPayload = new Map());
        byPayload.set(row.payload, (byPayload.get(row.payload) ?? 0) + 1);
    }
    return ledger;
}

/** 仅消费 snapshot 实际新增过的同一 occurrence；没有 credit 的迟到实时消息必须保留。 */
export function consumeHydrationCredit(ledger: HydrationCreditLedger | undefined, row: HydrationIdentity): boolean {
    if (!ledger || row.time > ledger.cutoff) return false;
    const byTopic = ledger.counts.get(row.time);
    const byPayload = byTopic?.get(row.topic);
    const remaining = byPayload?.get(row.payload) ?? 0;
    if (remaining <= 0) return false;
    if (remaining === 1) {
        byPayload!.delete(row.payload);
        if (byPayload!.size === 0) byTopic!.delete(row.topic);
        if (byTopic!.size === 0) ledger.counts.delete(row.time);
    } else {
        byPayload!.set(row.payload, remaining - 1);
    }
    return true;
}
