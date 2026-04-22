/** 忽略各种 Unicode 空白后小写化（与主进程 SQLite 查询策略一致） */
export function normalize(s: string): string {
    if (!s) return '';
    return s.replace(/\s+/gu, '').toLowerCase();
}

/** 轻量 HTML 转义 */
export function escapeHtml(s: string): string {
    return String(s).replace(/[&<>"']/g, (c) => {
        switch (c) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#39;';
            default: return c;
        }
    });
}

/**
 * 在 src 中高亮出现的关键字（大小写与空白不敏感，显示时保留原文）。
 * 策略：先对 src 计算 `normalized -> origIndex` 映射，在 normalized 里 indexOf，再把 match 区间映射回原字符串。
 */
export function highlight(src: string, keyword: string): string {
    if (!keyword) return escapeHtml(src);
    const k = normalize(keyword);
    if (!k) return escapeHtml(src);

    const norm: string[] = [];
    const map: number[] = [];
    for (let i = 0; i < src.length; i++) {
        const c = src.charAt(i);
        if (!/\s/.test(c)) {
            norm.push(c.toLowerCase());
            map.push(i);
        }
    }
    const ns = norm.join('');
    let out = '';
    let lastOrig = 0;
    let startPos = 0;
    while (true) {
        const found = ns.indexOf(k, startPos);
        if (found < 0) break;
        const origStart = map[found];
        const origEnd = map[found + k.length - 1] + 1;
        out += escapeHtml(src.slice(lastOrig, origStart));
        out += '<mark class="highlight">' + escapeHtml(src.slice(origStart, origEnd)) + '</mark>';
        lastOrig = origEnd;
        startPos = found + k.length;
    }
    out += escapeHtml(src.slice(lastOrig));
    return out;
}

/** 主题是否符合 MQTT 通配符订阅（仅用于订阅列表匹配显示用） */
export function topicMatches(filter: string, topic: string): boolean {
    const f = filter.split('/');
    const t = topic.split('/');
    for (let i = 0; i < f.length; i++) {
        const seg = f[i];
        if (seg === '#') return true;
        if (seg === '+') {
            if (t[i] == null) return false;
            continue;
        }
        if (t[i] !== seg) return false;
    }
    return f.length === t.length;
}
