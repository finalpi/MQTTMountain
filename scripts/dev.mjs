import { spawn } from 'node:child_process';
import process from 'node:process';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn('vite', process.argv.slice(2), {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env
});

let shuttingDown = false;

function stopChild(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;

  if (child.exitCode != null || child.killed) return;

  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    }).on('exit', () => undefined);
    return;
  }

  child.kill(signal);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopChild(signal);
  });
}

process.on('exit', () => {
  stopChild();
});

child.on('exit', (code, signal) => {
  shuttingDown = true;
  if (signal && process.listenerCount(signal) > 0) {
    process.exitCode = 0;
    return;
  }
  process.exitCode = code ?? 0;
});
