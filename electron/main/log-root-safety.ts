import fs from 'node:fs';
import path from 'node:path';

export const LOG_ROOT_MARKER_FILE = '.mqttmountain-log-root.json';
export const CONNECTION_DIR_MARKER_FILE = '.mqttmountain-connection.json';
export const DEDICATED_LOG_DIR_NAME = 'MQTTMountain-message-logs';

const MARKER_OWNER = 'MQTTMountain';
const MARKER_VERSION = 1;
const HISTORY_DB_FILE_RE = /^\d{4}-\d{2}-\d{2}(?:-\d{2})?\.db$/u;
const HISTORY_DB_SIDECAR_FILE_RE = /^\d{4}-\d{2}-\d{2}(?:-\d{2})?\.db(?:-wal|-shm)?$/u;

interface OwnershipMarker {
    owner: string;
    version: number;
    kind: 'log-root' | 'connection';
    connectionId?: string;
}

export interface OwnedHistoryFile {
    absolutePath: string;
    relativePath: string;
    size: number;
}

export interface DeletedOwnedHistory {
    deletedFiles: number;
    removedDir: boolean;
}

function normalizedPath(value: string): string {
    return path.resolve(value).replace(/[\\/]+$/u, '') || path.parse(path.resolve(value)).root;
}

export function isFileSystemRoot(value: string): boolean {
    const resolved = path.resolve(value);
    return normalizedPath(resolved).toLowerCase() === normalizedPath(path.parse(resolved).root).toLowerCase();
}

export function assertSafeLogRootPath(value: string): string {
    const resolved = path.resolve(String(value || '').trim());
    if (!value || !String(value).trim()) throw new Error('日志目录为空');
    if (isFileSystemRoot(resolved)) throw new Error('日志目录不能是磁盘或文件系统根目录');
    return resolved;
}

function readMarker(filePath: string, kind: OwnershipMarker['kind']): OwnershipMarker | null {
    try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) return null;
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<OwnershipMarker>;
        if (parsed.owner !== MARKER_OWNER || parsed.version !== MARKER_VERSION || parsed.kind !== kind) return null;
        return parsed as OwnershipMarker;
    } catch {
        return null;
    }
}

function writeMarker(filePath: string, marker: OwnershipMarker): void {
    const body = `${JSON.stringify(marker, null, 2)}\n`;
    try {
        fs.writeFileSync(filePath, body, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
        if (readMarker(filePath, marker.kind)) return;
        throw error;
    }
}

function isSafeDirectory(dir: string): boolean {
    try {
        const stat = fs.lstatSync(dir);
        return stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
        return false;
    }
}

function safeDirectoryEntries(dir: string): fs.Dirent[] | null {
    try {
        if (!isSafeDirectory(dir)) return null;
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return null;
    }
}

function legacyConnectionLayout(dir: string, allowEmpty: boolean): boolean {
    const entries = safeDirectoryEntries(dir);
    if (!entries) return false;
    let hasHistoryDb = false;
    for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || !HISTORY_DB_SIDECAR_FILE_RE.test(entry.name)) return false;
        if (HISTORY_DB_FILE_RE.test(entry.name)) hasHistoryDb = true;
    }
    return hasHistoryDb || (allowEmpty && entries.length === 0);
}

export function isMarkedLogRoot(root: string): boolean {
    return Boolean(readMarker(path.join(root, LOG_ROOT_MARKER_FILE), 'log-root'));
}

export function isMarkedConnectionDir(dir: string): boolean {
    return Boolean(readMarker(path.join(dir, CONNECTION_DIR_MARKER_FILE), 'connection'));
}

export function isOwnedConnectionDir(dir: string): boolean {
    return isMarkedConnectionDir(dir) || legacyConnectionLayout(dir, false);
}

export function isOwnedConnectionDirInRoot(root: string, dir: string): boolean {
    return isOwnedConnectionDirWithKnownRoot(isMarkedLogRoot(root), dir);
}

/** 同一次根目录扫描只读取一次 root marker，目录级校验仍逐项执行。 */
export function isOwnedConnectionDirWithKnownRoot(rootIsMarked: boolean, dir: string): boolean {
    return rootIsMarked
        ? isMarkedConnectionDir(dir) || legacyConnectionLayout(dir, false)
        : isOwnedConnectionDir(dir);
}

function repairLegacyConnectionMarkers(root: string, includeEmpty: boolean): void {
    for (const entry of safeDirectoryEntries(root) ?? []) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const dir = path.join(root, entry.name);
        if (isMarkedConnectionDir(dir) || !legacyConnectionLayout(dir, includeEmpty)) continue;
        writeMarker(path.join(dir, CONNECTION_DIR_MARKER_FILE), {
            owner: MARKER_OWNER,
            version: MARKER_VERSION,
            kind: 'connection',
            connectionId: entry.name
        });
    }
}

export function canAdoptLegacyLogRoot(root: string): boolean {
    const entries = safeDirectoryEntries(root);
    if (!entries || entries.length === 0) return false;
    let hasHistoryDb = false;
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
        const child = path.join(root, entry.name);
        const childEntries = safeDirectoryEntries(child);
        if (!childEntries) return false;
        for (const item of childEntries) {
            if (!item.isFile() || item.isSymbolicLink() || !HISTORY_DB_SIDECAR_FILE_RE.test(item.name)) return false;
            if (HISTORY_DB_FILE_RE.test(item.name)) hasHistoryDb = true;
        }
    }
    return hasHistoryDb;
}

export function canUseDirectLogRoot(root: string): boolean {
    const resolved = assertSafeLogRootPath(root);
    if (!fs.existsSync(resolved)) return false;
    const entries = safeDirectoryEntries(resolved);
    if (!entries) return false;
    return isMarkedLogRoot(resolved) || entries.length === 0 || canAdoptLegacyLogRoot(resolved);
}

export function resolveLogRootSelection(requested: string, defaultRoot: string): string {
    const trimmed = String(requested || '').trim();
    if (!trimmed) return assertSafeLogRootPath(defaultRoot);
    const selected = assertSafeLogRootPath(trimmed);
    if (canUseDirectLogRoot(selected)) return selected;
    const base = path.basename(selected).toLowerCase();
    if (!fs.existsSync(selected) && (base.includes('mqttmountain') || base === 'message_logs' || base === 'message-logs')) {
        return selected;
    }
    return assertSafeLogRootPath(path.join(selected, DEDICATED_LOG_DIR_NAME));
}

export function ensureOwnedLogRoot(root: string): string {
    const resolved = assertSafeLogRootPath(root);
    let adoptingLegacy = false;
    if (fs.existsSync(resolved)) {
        const entries = safeDirectoryEntries(resolved);
        if (!entries) throw new Error(`日志目录不可用或是符号链接: ${resolved}`);
        if (!isMarkedLogRoot(resolved) && entries.length > 0) {
            adoptingLegacy = canAdoptLegacyLogRoot(resolved);
            if (!adoptingLegacy) throw new Error(`目录包含非 MQTTMountain 数据，拒绝直接作为日志根目录: ${resolved}`);
        }
    } else {
        fs.mkdirSync(resolved, { recursive: true });
    }
    writeMarker(path.join(resolved, LOG_ROOT_MARKER_FILE), {
        owner: MARKER_OWNER,
        version: MARKER_VERSION,
        kind: 'log-root'
    });
    // Root marker creation and per-connection markers are deliberately idempotent.
    // If the process stopped after writing only the root marker, the next startup
    // continues adopting strict legacy directories instead of hiding old history.
    repairLegacyConnectionMarkers(resolved, adoptingLegacy);
    return resolved;
}

function ensureOwnedConnectionDirUnderRoot(ownedRoot: string, dirName: string, connectionId: string): string {
    const dir = path.join(ownedRoot, dirName);
    const relative = path.relative(ownedRoot, dir);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('非法连接日志目录');
    if (fs.existsSync(dir)) {
        const entries = safeDirectoryEntries(dir);
        if (!entries) throw new Error(`连接日志目录不可用或是符号链接: ${dir}`);
        if (!isMarkedConnectionDir(dir) && !legacyConnectionLayout(dir, true)) {
            throw new Error(`连接日志目录包含非应用数据，拒绝写入: ${dir}`);
        }
    } else {
        fs.mkdirSync(dir, { recursive: true });
    }
    writeMarker(path.join(dir, CONNECTION_DIR_MARKER_FILE), {
        owner: MARKER_OWNER,
        version: MARKER_VERSION,
        kind: 'connection',
        connectionId
    });
    return dir;
}

export function ensureOwnedConnectionDir(root: string, dirName: string, connectionId: string): string {
    return ensureOwnedConnectionDirUnderRoot(ensureOwnedLogRoot(root), dirName, connectionId);
}

/** 批量迁移专用：根 ownership 只验证一次，每个连接目录仍执行路径和内容校验。 */
export function ensureOwnedConnectionDirsInOwnedRoot(
    root: string,
    entries: Iterable<{ dirName: string; connectionId: string }>
): string[] {
    const ownedRoot = assertSafeLogRootPath(root);
    if (!isSafeDirectory(ownedRoot)) throw new Error(`日志目录不可用或是符号链接: ${ownedRoot}`);
    if (!isMarkedLogRoot(ownedRoot)) throw new Error(`日志根目录缺少 ownership marker: ${ownedRoot}`);
    const result: string[] = [];
    for (const entry of entries) {
        result.push(ensureOwnedConnectionDirUnderRoot(ownedRoot, entry.dirName, entry.connectionId));
    }
    return result;
}

export function listOwnedHistoryFiles(root: string): OwnedHistoryFile[] {
    const rootEntries = safeDirectoryEntries(root);
    if (!rootEntries) return [];
    const rootIsMarked = isMarkedLogRoot(root);
    const files: OwnedHistoryFile[] = [];
    for (const entry of rootEntries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const dir = path.join(root, entry.name);
        if (!isOwnedConnectionDirWithKnownRoot(rootIsMarked, dir)) continue;
        const entries = safeDirectoryEntries(dir) ?? [];
        for (const item of entries) {
            if (!item.isFile() || item.isSymbolicLink() || !HISTORY_DB_SIDECAR_FILE_RE.test(item.name)) continue;
            const absolutePath = path.join(dir, item.name);
            files.push({
                absolutePath,
                relativePath: path.join(entry.name, item.name),
                size: fs.statSync(absolutePath).size
            });
        }
    }
    return files;
}

function deleteOwnedConnectionHistoryUnchecked(dir: string, removeOwnershipMarker: boolean): DeletedOwnedHistory {
    const entries = safeDirectoryEntries(dir);
    if (!entries) return { deletedFiles: 0, removedDir: false };
    let deleted = 0;
    for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || !HISTORY_DB_SIDECAR_FILE_RE.test(entry.name)) continue;
        const filePath = path.join(dir, entry.name);
        fs.rmSync(filePath, { force: true });
        deleted++;
    }
    let removedDir = false;
    if (removeOwnershipMarker) {
        fs.rmSync(path.join(dir, CONNECTION_DIR_MARKER_FILE), { force: true });
        try {
            if ((safeDirectoryEntries(dir) ?? []).length === 0) {
                fs.rmdirSync(dir);
                removedDir = true;
            }
        } catch {}
    }
    return { deletedFiles: deleted, removedDir };
}

export function deleteOwnedConnectionHistory(dir: string, removeOwnershipMarker: boolean): number {
    if (!isOwnedConnectionDir(dir)) return 0;
    return deleteOwnedConnectionHistoryUnchecked(dir, removeOwnershipMarker).deletedFiles;
}

/** 根 marker 已读取的批量删除路径；仍逐目录验证 connection ownership。 */
export function deleteOwnedConnectionHistoryWithKnownRoot(
    rootIsMarked: boolean,
    dir: string,
    removeOwnershipMarker: boolean
): DeletedOwnedHistory {
    if (!isOwnedConnectionDirWithKnownRoot(rootIsMarked, dir)) {
        return { deletedFiles: 0, removedDir: false };
    }
    return deleteOwnedConnectionHistoryUnchecked(dir, removeOwnershipMarker);
}

export function deleteAllOwnedHistory(root: string, removeOwnershipMarkers: boolean): { deletedFiles: number; deletedDirs: number } {
    const entries = safeDirectoryEntries(root);
    if (!entries) return { deletedFiles: 0, deletedDirs: 0 };
    const rootIsMarked = isMarkedLogRoot(root);
    let deletedFiles = 0;
    let deletedDirs = 0;
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const dir = path.join(root, entry.name);
        const result = deleteOwnedConnectionHistoryWithKnownRoot(rootIsMarked, dir, removeOwnershipMarkers);
        deletedFiles += result.deletedFiles;
        if (result.removedDir) deletedDirs++;
    }
    return { deletedFiles, deletedDirs };
}
