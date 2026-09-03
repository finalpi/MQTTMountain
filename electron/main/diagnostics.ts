import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const DIAGNOSTIC_LOG_MAX_BYTES = 2 * 1024 * 1024;
let diagnosticDirReady = false;
let diagnosticLogBytes = -1;
let diagnosticLogFd: number | null = null;

function getDiagnosticLogPath(): string {
    return process.env.MQTTMOUNTAIN_DIAGNOSTIC_LOG_PATH
        ? path.resolve(process.env.MQTTMOUNTAIN_DIAGNOSTIC_LOG_PATH)
        : path.join(app.getPath('userData'), 'logs', 'main-diagnostics.log');
}

export function closeDiagnosticLog(): void {
    if (diagnosticLogFd == null) return;
    try { fs.closeSync(diagnosticLogFd); } catch {}
    diagnosticLogFd = null;
}

process.once('exit', closeDiagnosticLog);

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
        if (!diagnosticDirReady) {
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            diagnosticDirReady = true;
        }
        if (diagnosticLogBytes < 0) {
            try { diagnosticLogBytes = fs.statSync(logPath).size; } catch { diagnosticLogBytes = 0; }
        }
        const line = [new Date().toISOString(), label, ...values.map(formatDiagnosticValue)].join(' ') + '\n';
        const lineBytes = Buffer.byteLength(line, 'utf8');
        if (diagnosticLogBytes > 0 && diagnosticLogBytes + lineBytes > DIAGNOSTIC_LOG_MAX_BYTES) {
            closeDiagnosticLog();
            const rotatedPath = `${logPath}.1`;
            try { fs.rmSync(rotatedPath, { force: true }); } catch {}
            fs.renameSync(logPath, rotatedPath);
            diagnosticLogBytes = 0;
        }
        if (diagnosticLogFd == null) diagnosticLogFd = fs.openSync(logPath, 'a');
        fs.writeSync(diagnosticLogFd, line, null, 'utf8');
        diagnosticLogBytes += lineBytes;
    } catch {
        closeDiagnosticLog();
        diagnosticLogBytes = -1;
        // Diagnostics must never affect the app lifecycle.
    }
}
