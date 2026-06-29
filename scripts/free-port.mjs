/**
 * Stop any process listening on the suite HTTP port so a fresh server always starts.
 * Used by npm predev / prestart and Start-OmniSwim-Suite*.bat.
 */
import { execSync } from 'node:child_process';

const port = String(process.argv[2] ?? process.env.OMNI_PORT ?? process.env.PORT ?? '3000');

function freePortWindows() {
  try {
    const out = execSync(`netstat -ano | findstr ":${port} "`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
    }
    for (const pid of pids) {
      console.log(`[omniswim] Freeing port ${port} (PID ${pid})...`);
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
      } catch {
        console.warn(`[omniswim] Could not stop PID ${pid} — close the old server window manually.`);
      }
    }
  } catch {
    /* nothing listening */
  }
}

function freePortUnix() {
  try {
    const out = execSync(`lsof -ti :${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    for (const pid of out.trim().split(/\s+/).filter(Boolean)) {
      console.log(`[omniswim] Freeing port ${port} (PID ${pid})...`);
      try {
        execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
      } catch {
        console.warn(`[omniswim] Could not stop PID ${pid}.`);
      }
    }
  } catch {
    /* nothing listening */
  }
}

if (process.platform === 'win32') freePortWindows();
else freePortUnix();
