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

async function bootstrapFor(token) {
  const response = await fetch(`${apiBase}/api/bootstrap`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`bootstrap failed for token`);
  }
  return payload;
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
  assert(shell.ok, 'frontend shell must respond for rbac ui test');

  const professionalToken = await loginAs('profesional.demo', 'Quili.Pro!2026');
  const professionalBootstrap = await bootstrapFor(professionalToken);
  assert(professionalBootstrap.rbac?.view_access?.campaigns === false, 'professional ui contract must block campaigns');
  assert(professionalBootstrap.rbac?.action_access?.agenda_write === false, 'professional ui contract must block agenda write');
  assert(professionalBootstrap.slots.every((slot) => slot.allowed_actions?.block === false), 'professional ui contract must hide agenda block action');
  assert(professionalBootstrap.slots.every((slot) => slot.allowed_actions?.book === false), 'professional ui contract must hide appointment creation');

  const gestorToken = await loginAs('gestor.cesfam', 'Quili.Gestor!2026');
  const gestorBootstrap = await bootstrapFor(gestorToken);
  assert(gestorBootstrap.rbac?.action_access?.agenda_write === true, 'gestor ui contract must expose agenda write');
  assert(gestorBootstrap.slots.length >= 1, 'gestor must receive local visible slots');
  assert(gestorBootstrap.slots.every((slot) => slot.establishment_id === 'cesfam-bauza'), 'gestor ui contract must filter slots by establishment');
  assert(gestorBootstrap.slots.some((slot) => slot.allowed_actions?.block === true), 'gestor ui contract must expose at least one blockable slot');
  assert(gestorBootstrap.slots.some((slot) => slot.allowed_actions?.book === true), 'gestor ui contract must expose at least one reservable slot');

  if (!process.exitCode) {
    console.log('ui rbac http pass');
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
