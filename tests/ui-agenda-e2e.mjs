import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const backendPort = 4311;
const frontendPort = 4173;
const apiBase = `http://127.0.0.1:${backendPort}`;
const appBase = `http://127.0.0.1:${frontendPort}`;

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
  assert(shell.ok, 'frontend shell must respond for agenda ui test');
  const script = await fetch(`${appBase}/src/frontend/app.js`);
  assert(script.ok, 'frontend app script must be served for agenda ui flow');

  const token = await loginAs('gestor.cesfam', 'Quili.Gestor!2026');

  const availability = await request('/api/v1/agendas/disponibilidad?establishment_id=cesfam-bauza', token);
  assert(availability.status === 200, 'availability must succeed for ui agenda test');
  const freeSlot = availability.payload.items.find((item) => item.allowed_actions?.book);
  assert(Boolean(freeSlot), 'ui agenda test must find at least one reservable slot');

  const created = await request('/api/v1/citas', token, {
    method: 'POST',
    body: JSON.stringify({
      patient_id: 'P-1002',
      slot_id: freeSlot.id,
      channel: 'meson',
      note: 'Creada por ui-agenda-e2e'
    })
  });
  assert(created.status === 201, 'appointment create for ui agenda test must succeed');
  const createdId = created.payload.appointment?.id;
  assert(Boolean(createdId), 'appointment create for ui agenda test must return id');

  const bootstrap = await request('/api/bootstrap', token);
  assert(bootstrap.status === 200, 'bootstrap must succeed for ui agenda test');
  const appointment = bootstrap.payload.appointments.find((item) => item.id === createdId);
  assert(Boolean(appointment), 'created appointment must appear in bootstrap');
  assert(appointment.allowed_actions?.reprogram === true, 'gestor must see reprogram action');
  assert(Array.isArray(appointment.history) && appointment.history.length >= 1, 'created appointment must expose history');

  const targetSlot = availability.payload.items.find((item) => item.id !== freeSlot.id && item.establishment_id === freeSlot.establishment_id);
  assert(Boolean(targetSlot), 'ui agenda test must find second slot for reschedule');

  const reprogrammed = await request(`/api/v1/citas/${createdId}/reprogramar`, token, {
    method: 'POST',
    body: JSON.stringify({
      new_slot_id: targetSlot.id,
      reason: 'Reprogramacion ui agenda test'
    })
  });
  assert(reprogrammed.status === 200, 'appointment reprogram for ui agenda test must succeed');
  const nextAppointmentId = reprogrammed.payload.appointment?.id;
  assert(Boolean(nextAppointmentId), 'reprogram must return new appointment id');

  const after = await request('/api/bootstrap', token);
  assert(after.status === 200, 'bootstrap after reschedule must succeed');
  assert(after.payload.appointments.some((item) => item.id === nextAppointmentId && item.status === 'agendada'), 'bootstrap must include active reprogrammed appointment');
  assert(after.payload.appointments.some((item) => item.id === createdId && item.status === 'reprogramada'), 'bootstrap must keep previous appointment historized');

  const reset = await request('/api/demo/reset', token, {
    method: 'POST'
  });
  assert(reset.status === 200, 'reset must succeed after ui agenda test');

  if (!process.exitCode) {
    console.log('ui agenda http pass');
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
