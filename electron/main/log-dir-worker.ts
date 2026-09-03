import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import {
    deleteOwnedConnectionHistoryWithKnownRoot,
    ensureOwnedConnectionDirsInOwnedRoot,
    ensureOwnedLogRoot,
    isMarkedLogRoot,
    isOwnedConnectionDirWithKnownRoot,
    listOwnedHistoryFiles
} from './log-root-safety';

interface LogDirWorkerData {
    operation: 'copy' | 'delete';
    sourceDir: string;
    targetDir?: string;
}

const MIN_FREE_RESERVE_BYTES = 64 * 1024 * 1024;

function fileDigest(filePath: string): string {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        for (;;) {
            const read = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (read <= 0) break;
            hash.update(buffer.subarray(0, read));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function filesEqual(left: string, right: string, expectedSize: number): boolean {
    const rightStat = fs.statSync(right);
    return expectedSize === rightStat.size && fileDigest(left) === fileDigest(right);
}

function availableBytes(dir: string): number {
    const stats = fs.statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
}

function copyHistory(sourceDir: string, targetDir: string): { files: number; bytes: number; sourceDir: string; targetDir: string } {
    const source = ensureOwnedLogRoot(sourceDir);
    const target = ensureOwnedLogRoot(targetDir);
    const files = listOwnedHistoryFiles(source);
    const planned = files.map((file) => {
        const finalPath = path.join(target, file.relativePath);
        return { file, finalPath, exists: fs.existsSync(finalPath) };
    });
    const missing = planned.filter((entry) => !entry.exists).map((entry) => entry.file);
    const bytesToCopy = missing.reduce((sum, file) => sum + file.size, 0);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const reserve = Math.max(MIN_FREE_RESERVE_BYTES, Math.ceil(bytesToCopy * 0.05));
    const free = availableBytes(target);
    if (free < bytesToCopy + reserve) {
        throw new Error(`目标磁盘空间不足：需要 ${bytesToCopy + reserve} 字节，可用 ${free} 字节`);
    }

    for (const entry of planned) {
        if (entry.exists && !filesEqual(entry.file.absolutePath, entry.finalPath, entry.file.size)) {
            throw new Error(`目标目录存在不同内容的历史文件，拒绝覆盖: ${entry.finalPath}`);
        }
    }

    const stagingDir = path.join(target, `.mqttmountain-migration-${process.pid}-${Date.now()}`);
    fs.mkdirSync(stagingDir, { recursive: true });
    try {
        const connectionDirs = new Set(files.map((file) => file.relativePath.split(path.sep)[0]).filter(Boolean));
        for (const connectionDir of connectionDirs) {
            fs.mkdirSync(path.join(stagingDir, connectionDir), { recursive: true });
        }
        for (const file of missing) {
            const staged = path.join(stagingDir, file.relativePath);
            fs.copyFileSync(file.absolutePath, staged, fs.constants.COPYFILE_EXCL);
            const fd = fs.openSync(staged, 'r+');
            try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            if (fs.statSync(staged).size !== file.size) throw new Error(`迁移文件大小校验失败: ${file.relativePath}`);
        }

        ensureOwnedConnectionDirsInOwnedRoot(
            target,
            [...connectionDirs].map((connectionDir) => ({ dirName: connectionDir, connectionId: connectionDir }))
        );
        for (const file of missing) {
            const staged = path.join(stagingDir, file.relativePath);
            const finalPath = path.join(target, file.relativePath);
            fs.renameSync(staged, finalPath);
        }
    } finally {
        try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    }

    return {
        files: files.length,
        bytes: totalBytes,
        sourceDir: source,
        targetDir: target
    };
}

function deleteData(sourceDir: string): { files: number; bytes: number; sourceDir: string } {
    const source = ensureOwnedLogRoot(sourceDir);
    const ownedFiles = listOwnedHistoryFiles(source);
    const dirs = new Set(ownedFiles.map((file) => path.dirname(file.absolutePath)));
    const rootIsMarked = isMarkedLogRoot(source);
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(source, entry.name);
        if (dirs.has(dir)) continue;
        if (isOwnedConnectionDirWithKnownRoot(rootIsMarked, dir)) dirs.add(dir);
    }
    for (const dir of dirs) deleteOwnedConnectionHistoryWithKnownRoot(rootIsMarked, dir, true);
    return {
        files: ownedFiles.length,
        bytes: ownedFiles.reduce((sum, file) => sum + file.size, 0),
        sourceDir: source
    };
}

try {
    const data = workerData as LogDirWorkerData;
    let result;
    if (data.operation === 'copy') result = copyHistory(data.sourceDir, String(data.targetDir || ''));
    else if (data.operation === 'delete') result = deleteData(data.sourceDir);
    else throw new Error(`未知日志目录操作: ${String((data as { operation?: unknown }).operation)}`);
    parentPort?.postMessage({ ok: true, result });
} catch (error) {
    parentPort?.postMessage({ ok: false, error: (error as Error).message || String(error) });
}
