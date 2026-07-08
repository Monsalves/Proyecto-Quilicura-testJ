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
  assert(shell.ok, 'frontend shell must respond for waitlist ui test');
  const script = await fetch(`${appBase}/src/frontend/app.js`);
  assert(script.ok, 'frontend app script must be served for waitlist ui flow');

  const token = await loginAs('gestor.cesfam', 'Quili.Gestor!2026');

  const createProfessional = await request('/api/v1/profesionales', token, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Dra. Waitlist UI',
      discipline: 'Medicina general',
      establishment_id: 'cesfam-bauza',
      status: 'active'
    })
  });
  assert(createProfessional.status === 201, 'professional create for waitlist ui test must succeed');
  const professionalId = createProfessional.payload.professional?.id;
  assert(Boolean(professionalId), 'professional create for waitlist ui test must return id');

  const createService = await request('/api/v1/prestaciones', token, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Servicio waitlist UI',
      code: `WL-UI-${Date.now()}`,
      duration_minutes: 30,
      establishment_id: 'cesfam-bauza',
      status: 'active'
    })
  });
  assert(createService.status === 201, 'service create for waitlist ui test must succeed');
  const serviceId = createService.payload.service?.id;
  assert(Boolean(serviceId), 'service create for waitlist ui test must return id');

  const createAgenda = await request('/api/v1/agendas', token, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Agenda waitlist UI',
      establishment_id: 'cesfam-bauza',
      professional_id: professionalId,
      service_id: serviceId,
      status: 'active'
    })
  });
  assert(createAgenda.status === 201, 'agenda create for waitlist ui test must succeed');
  const agendaId = createAgenda.payload.agenda?.id;
  assert(Boolean(agendaId), 'agenda create for waitlist ui test must return id');

  const createWaitlist = await request('/api/v1/lista-espera', token, {
    method: 'POST',
    body: JSON.stringify({
      patient_id: 'P-1002',
      service_id: serviceId,
      establishment_id: 'cesfam-bauza',
      note: 'Creada por ui-waitlist-e2e'
    })
  });
  assert(createWaitlist.status === 201, 'waitlist create for ui test must succeed');
  const waitlistId = createWaitlist.payload.waitlist_entry?.id;
  assert(Boolean(waitlistId), 'waitlist create for ui test must return id');

  const createSlot = await request('/api/v1/cupos', token, {
    method: 'POST',
    body: JSON.stringify({
      agenda_id: agendaId,
      starts_at: '2030-09-03T13:30:00.000Z',
      ends_at: '2030-09-03T14:00:00.000Z',
      status: 'disponible',
      note: 'Cupo creado por ui-waitlist-e2e'
    })
  });
  assert(createSlot.status === 201, 'slot create for waitlist ui test must succeed');
  const slotId = createSlot.payload.slot?.id;
  assert(Boolean(slotId), 'slot create for waitlist ui test must return id');

  const createOffer = await request(`/api/v1/lista-espera/${waitlistId}/ofertas`, token, {
    method: 'POST',
    body: JSON.stringify({
      slot_id: slotId,
      note: 'Oferta ui waitlist'
    })
  });
  assert(createOffer.status === 201, 'waitlist offer for ui test must succeed');
  const offerId = createOffer.payload.offer?.id;
  assert(Boolean(offerId), 'waitlist offer for ui test must return id');

  const bootstrap = await request('/api/bootstrap', token);
  assert(bootstrap.status === 200, 'bootstrap must succeed for waitlist ui test');
  const waitlistEntry = bootstrap.payload.waitlist.find((item) => item.id === waitlistId);
  assert(Boolean(waitlistEntry), 'created waitlist entry must appear in bootstrap');
  assert(waitlistEntry.active_offer?.id === offerId, 'bootstrap must expose active waitlist offer');

  const rejectOffer = await request(`/api/v1/lista-espera/ofertas/${offerId}/resolver`, token, {
    method: 'POST',
    body: JSON.stringify({
      resolution: 'rechazada',
      reason: 'Paciente no acepta horario'
    })
  });
  assert(rejectOffer.status === 200, 'waitlist offer rejection must succeed');
  assert(rejectOffer.payload.waitlist_entry?.status === 'activa', 'rejected waitlist offer must reactivate waitlist entry');

  const closeWaitlist = await request(`/api/v1/lista-espera/${waitlistId}/cerrar`, token, {
    method: 'POST',
    body: JSON.stringify({
      reason: 'Se agenda por otro canal local'
    })
  });
  assert(closeWaitlist.status === 200, 'waitlist close in ui test must succeed');

  const reset = await request('/api/demo/reset', token, {
    method: 'POST'
  });
  assert(reset.status === 200, 'reset must succeed after ui waitlist test');

  if (!process.exitCode) {
    console.log('ui waitlist http pass');
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
