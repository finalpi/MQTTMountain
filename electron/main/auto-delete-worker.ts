import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import {
    HISTORY_DB_SIDECAR_FILE_RE,
    historyFileKeyFromName,
    historyFileTimeRangeFromKey
} from './history-query-common';

interface WorkerData {
    logRoot: string;
    cutoff: number;
}

let removed = 0;

try {
    const { logRoot, cutoff } = workerData as WorkerData;
    if (fs.existsSync(logRoot)) {
        const dirs = fs.readdirSync(logRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
        for (const d of dirs) {
            const sub = path.join(logRoot, d.name);
            const files = fs.readdirSync(sub).filter((f) => HISTORY_DB_SIDECAR_FILE_RE.test(f));
            for (const f of files) {
                const key = historyFileKeyFromName(f);
                const range = key ? historyFileTimeRangeFromKey(key) : null;
                if (range && range.end < cutoff) {
                    try {
                        fs.unlinkSync(path.join(sub, f));
                        removed++;
                    } catch {}
                }
            }
        }
    }
    parentPort?.postMessage({ removed });
} catch (e) {
    parentPort?.postMessage({ removed, error: (e as Error).message });
}
