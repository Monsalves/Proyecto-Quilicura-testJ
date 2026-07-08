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
  assert(shell.ok, 'frontend shell must respond for contact ui test');
  const script = await fetch(`${appBase}/src/frontend/app.js`);
  assert(script.ok, 'frontend app script must be served for contact ui flow');

  const token = await loginAs('admin.comunal', 'Quili.Admin!2026');

  const createTemplate = await request('/api/v1/contactabilidad/plantillas', token, {
    method: 'POST',
    body: JSON.stringify({
      code: 'TPL-CONTACT-99',
      name: 'Plantilla UI contacto',
      version: 1,
      channel: 'telefono',
      purpose: 'recordatorio_cita',
      language: 'espanol',
      status: 'active',
      contains_sensitive_detail: false,
      content: 'Recordatorio local desde prueba UI.'
    })
  });
  assert(createTemplate.status === 201, 'contact template create for ui test must succeed');

  const sendContact = await request('/api/v1/contactabilidad/envios', token, {
    method: 'POST',
    body: JSON.stringify({
      patient_id: 'P-1001',
      template_id: 'TPL-0001',
      purpose: 'recordatorio_cita',
      channel: 'telefono',
      detail: 'Envio local ui-contact-e2e'
    })
  });
  assert(sendContact.status === 201, 'contact send for ui test must succeed');
  const caseId = sendContact.payload.contact_case?.id;
  const messageId = sendContact.payload.contact_message?.id;
  assert(Boolean(caseId), 'contact send for ui test must return case id');
  assert(Boolean(messageId), 'contact send for ui test must return message id');

  const webhook = await request('/api/v1/contactabilidad/webhook', token, {
    method: 'POST',
    body: JSON.stringify({
      message_id: messageId,
      status: 'responded',
      result: 'success',
      detail: 'Paciente confirma recepcion local'
    })
  });
  assert(webhook.status === 200, 'contact webhook for ui test must succeed');

  const bootstrap = await request('/api/bootstrap', token);
  assert(bootstrap.status === 200, 'bootstrap must succeed for contact ui test');
  const visibleCase = bootstrap.payload.contact_cases.find((item) => item.id === caseId);
  assert(Boolean(visibleCase), 'contact case must appear in bootstrap');
  assert(visibleCase.attempts.some((item) => item.id === messageId && item.status === 'responded'), 'contact attempt must reflect webhook result');

  const reset = await request('/api/demo/reset', token, {
    method: 'POST'
  });
  assert(reset.status === 200, 'reset must succeed after contact ui test');

  if (!process.exitCode) {
    console.log('ui contact http pass');
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
