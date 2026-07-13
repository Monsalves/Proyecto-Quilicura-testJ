import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const backendPort = 4313;
const frontendPort = 4174;
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
  assert(shell.ok, 'frontend shell must respond for campaigns ui test');
  const script = await fetch(`${appBase}/src/frontend/app.js`);
  assert(script.ok, 'frontend app script must be served for campaigns ui flow');
  const scriptSource = await script.text();
  assert(scriptSource.includes('data-campaign-panel="create"'), 'campaigns ui must expose create subsection');
  assert(scriptSource.includes('data-campaign-panel="approve"'), 'campaigns ui must expose approval subsection');
  assert(scriptSource.includes('data-campaign-panel="schedule"'), 'campaigns ui must expose schedule subsection');
  assert(scriptSource.includes('data-campaign-panel="export"'), 'campaigns ui must expose aggregate export subsection');

  const token = await loginAs('admin.comunal', 'Quili.Admin!2026');

  const createCampaign = await request('/api/v1/campanas', token, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Campana UI campañas',
      purpose: 'contactabilidad_preventiva',
      channel: 'sms',
      audience: 'Pacientes activos con consentimiento',
      establishment_id: 'cesfam-bauza',
      template_id: 'TPL-0004'
    })
  });
  assert(createCampaign.status === 201, 'campaign create for ui test must succeed');
  const campaignId = createCampaign.payload.campaign?.id;
  assert(Boolean(campaignId), 'campaign create for ui test must return id');

  const approval = await request(`/api/v1/campanas/${campaignId}/aprobacion`, token, {
    method: 'POST',
    body: JSON.stringify({
      approval_note: 'Aprobacion desde prueba UI'
    })
  });
  assert(approval.status === 200, 'campaign approve for ui test must succeed');

  const schedule = await request(`/api/v1/campanas/${campaignId}/programacion`, token, {
    method: 'POST',
    body: JSON.stringify({
      scheduled_at: '2030-07-18T12:00:00.000Z',
      execution_note: 'Programacion UI local'
    })
  });
  assert(schedule.status === 200, 'campaign schedule for ui test must succeed');

  const surveyResponse = await request('/api/v1/encuestas/ENC-001/respuestas', token, {
    method: 'POST',
    body: JSON.stringify({
      campaign_id: 'CAM-22',
      patient_id: 'P-1004',
      score: 5,
      channel: 'whatsapp',
      comment: 'Respuesta registrada desde prueba UI'
    })
  });
  assert(surveyResponse.status === 201, 'survey response for ui test must succeed');

  const bootstrap = await request('/api/bootstrap', token);
  assert(bootstrap.status === 200, 'bootstrap must succeed for campaigns ui test');
  const visibleCampaign = bootstrap.payload.campaigns.find((item) => item.id === campaignId);
  assert(Boolean(visibleCampaign), 'created campaign must appear in bootstrap');
  assert(visibleCampaign.status === 'scheduled', 'created campaign must appear scheduled in bootstrap');
  assert((visibleCampaign.metrics?.delivered || 0) >= 1, 'created campaign bootstrap must show delivered recipients');
  assert((bootstrap.payload.surveys || []).some((item) => item.id === 'ENC-001' && (item.response_count || 0) >= 2), 'survey aggregate must appear in bootstrap');

  const reset = await request('/api/demo/reset', token, {
    method: 'POST'
  });
  assert(reset.status === 200, 'reset must succeed after campaigns ui test');

  if (!process.exitCode) {
    console.log('ui campaigns http pass');
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
