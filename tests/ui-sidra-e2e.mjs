import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const backendPort = 4313;
const frontendPort = 4174;
const apiBase = `http://127.0.0.1:${backendPort}`;
const appBase = `http://127.0.0.1:${frontendPort}`;

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

function spawnService(args) {
  return spawn(process.execPath, args, {
    cwd: workspaceRoot,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
    }
    await delay(200);
  }
  throw new Error(`service did not become healthy: ${url}`);
}

async function loginAs(username, password) {
  const response = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`api login failed for ${username}`);
  }
  return payload.auth.token;
}

async function request(path, token, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

const backend = spawnService(['src/backend/server.mjs', '--port', String(backendPort)]);
const frontend = spawnService(['src/frontend/dev-server.mjs', '--port', String(frontendPort)]);

let backendStderr = '';
let frontendStderr = '';
backend.stderr.on('data', (chunk) => {
  backendStderr += chunk.toString();
});
frontend.stderr.on('data', (chunk) => {
  frontendStderr += chunk.toString();
});

try {
  await waitFor(`${apiBase}/health`);
  await waitFor(`${appBase}/`);

  const shell = await fetch(`${appBase}/`);
  assert(shell.ok, 'frontend shell must respond for sidra ui test');
  const script = await fetch(`${appBase}/src/frontend/app.js`);
  assert(script.ok, 'frontend app script must be served for sidra ui flow');

  const token = await loginAs('admin.comunal', 'Quili.Admin!2026');

  const createEvent = await request('/api/v1/sidra/eventos', token, {
    method: 'POST',
    body: JSON.stringify({
      type: 'manual.ui.sidra',
      entity: 'manual_batch',
      entity_id: 'UI-SIDRA-001',
      establishment_id: 'cesfam-quilicura',
      simulation_default_result: 'discrepancy',
      payload: {
        source: 'ui-sidra-e2e'
      }
    })
  });
  assert(createEvent.status === 201, 'sidra event create for ui test must succeed');
  const eventId = createEvent.payload.sidra_event?.id;
  assert(Boolean(eventId), 'sidra ui test must return sidra event id');

  const bootstrap = await request('/api/bootstrap', token);
  assert(bootstrap.status === 200, 'bootstrap must succeed for sidra ui test');
  assert(bootstrap.payload.sidra.some((item) => item.id === eventId), 'sidra event must appear in bootstrap');

  const discrepancy = await request(`/api/v1/sidra/eventos/${eventId}/procesar`, token, {
    method: 'POST',
    body: JSON.stringify({
      result: 'discrepancy',
      detail: 'Desfase UI SIDRA local',
      error_code: 'UI_DIFF'
    })
  });
  assert(discrepancy.status === 200, 'sidra discrepancy process for ui test must succeed');
  assert(discrepancy.payload.sidra_event?.status === 'discrepancy', 'ui sidra event must move to discrepancy');

  const resolved = await request(`/api/v1/sidra/eventos/${eventId}/discrepancia/resolver`, token, {
    method: 'POST',
    body: JSON.stringify({
      resolution_note: 'Conciliacion manual desde flujo UI local'
    })
  });
  assert(resolved.status === 200, 'sidra discrepancy resolve for ui test must succeed');
  assert(resolved.payload.sidra_event?.status === 'acknowledged', 'resolved ui sidra event must become acknowledged');

  const reset = await request('/api/demo/reset', token, {
    method: 'POST'
  });
  assert(reset.status === 200, 'reset must succeed after sidra ui test');

  if (!process.exitCode) {
    console.log('ui sidra http pass');
  }
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  if (backendStderr) {
    console.error(backendStderr);
  }
  if (frontendStderr) {
    console.error(frontendStderr);
  }
  process.exitCode = 1;
} finally {
  backend.kill('SIGTERM');
  frontend.kill('SIGTERM');
  await delay(250);
}
