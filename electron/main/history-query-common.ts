import fs from 'node:fs';
import path from 'node:path';
import type { HistoryKeywordJoin, HistoryQueryOptions } from '../../shared/types';

export const DATE_KEY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.db$/;

export interface DayFileEntry {
    path: string;
    dk: string;
    san: string;
}

export interface NormalizedCondition {
    join: HistoryKeywordJoin;
    term: string;
}

export function sanitizeConnectionId(id: string): string {
    if (!id) return '_none';
    const s = String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
    return s.length > 120 ? s.slice(0, 120) : s || '_empty';
}

export function normalizeKeyword(value: string): string {
    return String(value || '').replace(/\s+/gu, '').toLowerCase();
}

export function normalizePayloadSearchText(payload: string): string {
    return normalizeKeyword(payload);
}

export function normalizeCombinedSearchText(topic: string, payload: string): string {
    return `${normalizeKeyword(topic)}${normalizeKeyword(payload)}`;
}

export function normalizeSearchText(topic: string, payload: string): string {
    void topic;
    return normalizePayloadSearchText(payload);
}

export function dayStartTsFromKey(dk: string): number {
    const [y, mo, da] = dk.split('-').map(Number);
    return new Date(y, mo - 1, da, 0, 0, 0, 0).getTime();
}

export function dayEndTsFromKey(dk: string): number {
    return dayStartTsFromKey(dk) + 86_400_000 - 1;
}

export function dateKeyFromTs(tsMs: number): string {
    const d = new Date(tsMs);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

export function parseKeywordTerms(input: string | string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const items = Array.isArray(input) ? input : [input];
    for (const part of items) {
        const term = normalizeKeyword(part);
        if (!term || seen.has(term)) continue;
        seen.add(term);
        out.push(term);
    }
    return out;
}

export function normalizeConditions(conditions?: HistoryQueryOptions['conditions']): NormalizedCondition[] {
    return (conditions ?? [])
        .map((item) => ({ join: item.join, term: normalizeKeyword(item.term) }))
        .filter((item) => item.term);
}

export function matchesConditions(hay: string, conditions: NormalizedCondition[]): boolean {
    if (conditions.length === 0) return true;
    let result = hay.includes(conditions[0].term);
    for (let i = 1; i < conditions.length; i++) {
        const item = conditions[i];
        const hit = hay.includes(item.term);
        if (item.join === 'or') result = result || hit;
        else if (item.join === 'not') result = result && !hit;
        else result = result && hit;
    }
    return result;
}

export function matchesSearchText(hay: string, conditions: NormalizedCondition[], terms: string[], keywordLogic: 'and' | 'or'): boolean {
    if (conditions.length === 0 && terms.length === 0) return true;
    if (conditions.length) return matchesConditions(hay, conditions);
    return keywordLogic === 'or'
        ? terms.some((term) => hay.includes(term))
        : terms.every((term) => hay.includes(term));
}

export function matchesText(topic: string, payload: string, conditions: NormalizedCondition[], terms: string[], keywordLogic: 'and' | 'or'): boolean {
    return matchesSearchText(`${normalizeKeyword(topic)}${normalizeKeyword(payload)}`, conditions, terms, keywordLogic);
}

export function collectDayFiles(logRoot: string, opts: { connectionId?: string | null; startTime?: number; endTime?: number; order?: 'asc' | 'desc' } = {}): DayFileEntry[] {
    if (!fs.existsSync(logRoot)) return [];
    const st = opts.startTime != null && opts.startTime > 0 ? opts.startTime : -8640000000000000;
    const et = opts.endTime != null && opts.endTime > 0 ? opts.endTime : 8640000000000000;
    const sanFilter = opts.connectionId ? sanitizeConnectionId(opts.connectionId) : null;
    const dirs = fs.readdirSync(logRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && (!sanFilter || d.name === sanFilter));
    const files: DayFileEntry[] = [];
    for (const d of dirs) {
        const dir = path.join(logRoot, d.name);
        const dayFiles = fs.readdirSync(dir).filter((f) => DATE_KEY_FILE_RE.test(f));
        for (const df of dayFiles) {
            const dk = df.replace('.db', '');
            if (dayEndTsFromKey(dk) < st || dayStartTsFromKey(dk) > et) continue;
            files.push({ path: path.join(dir, df), dk, san: d.name });
        }
    }
    files.sort((a, b) => opts.order === 'asc'
        ? (a.dk < b.dk ? -1 : a.dk > b.dk ? 1 : 0)
        : (a.dk < b.dk ? 1 : a.dk > b.dk ? -1 : 0));
    return files;
}
