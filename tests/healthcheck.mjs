import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const fallbackPort = 4315;
const baseUrl = process.env.BACKEND_URL || `http://127.0.0.1:${fallbackPort}`;
const runtime = JSON.parse(readFileSync(new URL('../config/operational.json', import.meta.url), 'utf8'));

function startBackend() {
  if (process.env.BACKEND_URL) {
    return null;
  }
  return spawn(process.execPath, ['src/backend/server.mjs', '--port', String(fallbackPort)], {
    cwd: workspaceRoot,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return response;
      }
    } catch {
    }
    await delay(200);
  }
  throw new Error('health endpoint did not become ready');
}

const backend = startBackend();
let stderr = '';
backend?.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

try {
  const response = await waitForHealth();
  if (!response.ok) {
    throw new Error(`health failed with ${response.status}`);
  }

  const health = await response.json();
  if (health.status !== 'ok') {
    throw new Error('health endpoint did not return ok');
  }
  if (health.version !== runtime.version) {
    throw new Error(`unexpected version ${health.version}`);
  }

  console.log(`healthcheck ok ${health.version} ${health.sidra_mode}`);
} catch (error) {
  if (stderr) {
    console.error(stderr);
  }
  throw error;
} finally {
  backend?.kill('SIGTERM');
  await delay(250);
}
