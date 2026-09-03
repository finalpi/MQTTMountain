/**
 * MQTT topic filter 工具：判断两个通配符 filter 的覆盖关系。
 *
 * 通配符规则：
 *   '#' 匹配零个或多个层级，必须在末尾
 *   '+' 匹配单个层级
 *
 * covers(a, b) 判定："订阅了 a 就一定会收到 b 上的所有消息"
 *   covers('a/#', 'a/b')   → true
 *   covers('a/+/c', 'a/b/c') → true
 *   covers('a/b', 'a/+')   → false（a/b 不能覆盖 a/+ 能匹配的其他主题）
 *   covers('a/b', 'a/b')   → true（等同即包含自己）
 */
export function topicFilterCovers(a: string, b: string): boolean {
    if (!isValidTopicFilter(a) || !isValidTopicFilter(b)) return false;
    if (a === b) return true;
    const ap = a.split('/');
    const bp = b.split('/');

    // MQTT 通配符位于首层时不匹配 `$` 开头的系统主题。
    const bMatchesSystem = bp[0]?.startsWith('$') ?? false;
    const aMatchesSystem = ap[0]?.startsWith('$') ?? false;
    if (bMatchesSystem && !aMatchesSystem) return false;
    if (!bMatchesSystem && aMatchesSystem) return false;

    let ai = 0;
    let bi = 0;
    while (true) {
        const as = ap[ai];
        const bs = bp[bi];
        if (as === '#') return true;
        if (bs === '#') return false;
        if (as == null || bs == null) {
            if (as == null && bs == null) return true;
            // B 已结束时，A 仅能用末尾 # 覆盖“零层后缀”。
            return bs == null && as === '#';
        }
        if (as === '+') {
            ai++;
            bi++;
            continue;
        }
        // B 的 + 代表任意一层，不能被 A 的字面量完整覆盖。
        if (bs === '+' || as !== bs) return false;
        ai++;
        bi++;
    }
}

export function isValidTopicFilter(filter: string): boolean {
    if (!filter || filter.includes('\0')) return false;
    const parts = filter.split('/');
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part.includes('#') && (part !== '#' || i !== parts.length - 1)) return false;
        if (part.includes('+') && part !== '+') return false;
    }
    return true;
}

/**
 * 从一批 filter 里挑出「互不包含的最大集合」：
 * 对每个 filter，如果能被其他 filter 覆盖（且不相等）就丢掉。
 */
export function pickOutermost<T extends { topic: string }>(subs: T[]): T[] {
    const result: T[] = [];
    for (const s of subs) {
        const coveredBy = subs.find((o) => {
            if (o === s || o.topic === s.topic || !topicFilterCovers(o.topic, s.topic)) return false;
            const outerQos = 'qos' in o ? Number((o as T & { qos?: unknown }).qos) : null;
            const innerQos = 'qos' in s ? Number((s as T & { qos?: unknown }).qos) : null;
            return outerQos == null || innerQos == null || outerQos >= innerQos;
        });
        if (coveredBy) continue;
        // 跳过重复（相同 topic 只保留第一个）
        if (result.some((r) => r.topic === s.topic)) continue;
        result.push(s);
    }
    return result;
}
