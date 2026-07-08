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
  assert(shell.ok, 'frontend shell must respond for patient ui test');

  const token = await loginAs('gestor.cesfam', 'Quili.Gestor!2026');
  const create = await fetch(`${apiBase}/api/v1/pacientes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      rut: '88.888.888-8',
      legal_name: 'Paciente UI Demo',
      social_name: 'UI Demo',
      birth_date: '1992-06-15',
      establishment_id: 'cesfam-bauza',
      sector: 'Sector UI',
      risk: 'Seguimiento preventivo',
      notes: 'Creado por ui-patients-e2e'
    })
  });
  const created = await create.json();
  assert(create.status === 201, 'patient api create for ui test must succeed');

  const bootstrap = await fetch(`${apiBase}/api/bootstrap`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const bootstrapPayload = await bootstrap.json();
  assert(bootstrap.ok, 'bootstrap must succeed for patient ui test');
  const patient = bootstrapPayload.patients.find((item) => item.id === created.patient.id);
  assert(Boolean(patient), 'created patient must appear in bootstrap');
  assert(patient.allowed_actions?.manage === true, 'gestor must see manage action on created patient');
  assert(Array.isArray(patient.contacts) && patient.contacts.length === 0, 'created patient must expose nested contacts array');
  assert(patient.establishment_id === 'cesfam-bauza', 'created patient must remain in gestor scope');

  const script = await fetch(`${appBase}/src/frontend/app.js`);
  assert(script.ok, 'frontend app script must be served for patient ui flow');

  if (!process.exitCode) {
    console.log('ui patient http pass');
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
