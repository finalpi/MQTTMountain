import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import {
    HISTORY_DB_SIDECAR_FILE_RE,
    historyFileKeyFromName,
    historyFileTimeRangeFromKey
} from './history-query-common';
import { isMarkedLogRoot, isOwnedConnectionDirWithKnownRoot } from './log-root-safety';

interface WorkerData {
    logRoot: string;
    cutoff: number;
}

let removed = 0;
const failures: Array<{ path: string; message: string }> = [];
const rangeByKey = new Map<string, ReturnType<typeof historyFileTimeRangeFromKey>>();

try {
    const { logRoot, cutoff } = workerData as WorkerData;
    if (fs.existsSync(logRoot)) {
        const rootIsMarked = isMarkedLogRoot(logRoot);
        const dirs = fs.readdirSync(logRoot, { withFileTypes: true });
        for (const d of dirs) {
            if (!d.isDirectory()) continue;
            const sub = path.join(logRoot, d.name);
            if (!isOwnedConnectionDirWithKnownRoot(rootIsMarked, sub)) continue;
            const files = fs.readdirSync(sub);
            for (const f of files) {
                if (!HISTORY_DB_SIDECAR_FILE_RE.test(f)) continue;
                const key = historyFileKeyFromName(f);
                let range = key ? rangeByKey.get(key) : null;
                if (key && !rangeByKey.has(key)) {
                    range = historyFileTimeRangeFromKey(key);
                    rangeByKey.set(key, range);
                }
                if (range && range.end < cutoff) {
                    try {
                        fs.unlinkSync(path.join(sub, f));
                        removed++;
                    } catch (error) {
                        failures.push({
                            path: path.join(sub, f),
                            message: (error as Error).message || String(error)
                        });
                    }
                }
            }
        }
    }
    parentPort?.postMessage({ removed, failures: failures.slice(0, 20), failed: failures.length });
} catch (e) {
    parentPort?.postMessage({ removed, failures: failures.slice(0, 20), failed: failures.length, error: (e as Error).message });
}
