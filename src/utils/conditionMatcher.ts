export interface NormalizedJoinedCondition {
    term: string;
    join: 'and' | 'or' | 'not';
}

export function matchesNormalizedConditions(hay: string, conditions: readonly NormalizedJoinedCondition[]): boolean {
    if (conditions.length === 0) return true;
    const firstHit = hay.includes(conditions[0].term);
    let result = conditions[0].join === 'not' ? !firstHit : firstHit;
    for (let i = 1; i < conditions.length; i++) {
        const item = conditions[i];
        const hit = hay.includes(item.term);
        if (item.join === 'or') result = result || hit;
        else if (item.join === 'not') result = result && !hit;
        else result = result && hit;
    }
    return result;
}
