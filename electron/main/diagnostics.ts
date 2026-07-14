import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const DIAGNOSTIC_LOG_MAX_BYTES = 2 * 1024 * 1024;

function getDiagnosticLogPath(): string {
    return path.join(app.getPath('userData'), 'logs', 'main-diagnostics.log');
}

function formatDiagnosticValue(value: unknown): string {
    if (value instanceof Error) return `${value.stack || value.message}`;
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

export function writeDiagnosticLog(label: string, ...values: unknown[]): void {
    try {
        const logPath = getDiagnosticLogPath();
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        if (fs.existsSync(logPath) && fs.statSync(logPath).size > DIAGNOSTIC_LOG_MAX_BYTES) {
            const rotatedPath = `${logPath}.1`;
            try { fs.rmSync(rotatedPath, { force: true }); } catch {}
            fs.renameSync(logPath, rotatedPath);
        }
        const line = [new Date().toISOString(), label, ...values.map(formatDiagnosticValue)].join(' ') + '\n';
        fs.appendFileSync(logPath, line, 'utf8');
    } catch {
        // Diagnostics must never affect the app lifecycle.
    }
}
