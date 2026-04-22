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
    if (a === b) return true;
    const ap = a.split('/');
    const bp = b.split('/');
    for (let i = 0; i < ap.length; i++) {
        const as = ap[i];
        if (as === '#') return true;
        if (i >= bp.length) return false;
        const bs = bp[i];
        if (as === '+') continue;
        if (as !== bs) return false;
    }
    return ap.length === bp.length;
}

/**
 * 从一批 filter 里挑出「互不包含的最大集合」：
 * 对每个 filter，如果能被其他 filter 覆盖（且不相等）就丢掉。
 */
export function pickOutermost<T extends { topic: string }>(subs: T[]): T[] {
    const result: T[] = [];
    for (const s of subs) {
        const coveredBy = subs.find((o) => o !== s && o.topic !== s.topic && topicFilterCovers(o.topic, s.topic));
        if (coveredBy) continue;
        // 跳过重复（相同 topic 只保留第一个）
        if (result.some((r) => r.topic === s.topic)) continue;
        result.push(s);
    }
    return result;
}
