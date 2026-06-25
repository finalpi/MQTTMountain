import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

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
            const files = fs.readdirSync(sub).filter((f) => /^\d{4}-\d{2}-\d{2}\.db(?:-wal|-shm)?$/u.test(f));
            for (const f of files) {
                const match = /^(\d{4}-\d{2}-\d{2})\.db(?:-wal|-shm)?$/u.exec(f);
                if (!match) continue;
                const [y, m, dd] = match[1].split('-').map(Number);
                const dayEnd = new Date(y, m - 1, dd, 23, 59, 59, 999).getTime();
                if (dayEnd < cutoff) {
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
