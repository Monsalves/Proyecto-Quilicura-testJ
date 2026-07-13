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
  const html = await shell.text();
  assert(shell.ok, 'frontend shell must respond 200');
  assert(shell.headers.get('content-type')?.includes('text/html'), 'frontend shell must be html');
  assert(html.includes('<div id="app"></div>'), 'frontend shell must expose app mount');
  assert(html.includes('src/frontend/app.js'), 'frontend shell must reference app script');

  const script = await fetch(`${appBase}/src/frontend/app.js`);
  assert(script.ok, 'frontend app script must be served');
  assert(script.headers.get('content-type')?.includes('text/javascript'), 'frontend app script must be javascript');
  const scriptSource = await script.text();
  assert(!scriptSource.includes('sidebar-toggle'), 'frontend shell must not expose sidebar collapse toggle');

  const invalidLogin = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'admin.comunal',
      password: 'incorrecta'
    })
  });
  const invalidPayload = await invalidLogin.json();
  assert(invalidLogin.status === 401, 'invalid api login must fail');
  assert(invalidPayload.error === 'invalid_credentials', 'invalid login error must be structured');

  const login = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'admin.comunal',
      password: 'Quili.Admin!2026'
    })
  });
  const payload = await login.json();
  assert(login.ok, 'admin api login precondition must succeed');

  const session = await fetch(`${apiBase}/api/auth/session`, {
    headers: {
      Authorization: `Bearer ${payload.auth.token}`
    }
  });
  const sessionPayload = await session.json();
  assert(session.ok, 'session endpoint must succeed for ui smoke');
  assert(sessionPayload.rbac?.role?.id === 'administrador_comunal', 'session contract must expose admin role');

  const bootstrap = await fetch(`${apiBase}/api/bootstrap`, {
    headers: {
      Authorization: `Bearer ${payload.auth.token}`
    }
  });
  const bootstrapPayload = await bootstrap.json();
  assert(bootstrap.ok, 'bootstrap endpoint must succeed for ui smoke');
  assert(bootstrapPayload.rbac?.permissions?.includes('dashboard.view'), 'bootstrap must expose dashboard permission');
  assert(bootstrapPayload.summary?.patients >= 100, 'bootstrap summary must expose seeded volume for admin');

  const logout = await fetch(`${apiBase}/api/auth/logout`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${payload.auth.token}`
    }
  });
  assert(logout.ok, 'logout endpoint must succeed');

  const afterLogout = await fetch(`${apiBase}/api/auth/session`, {
    headers: {
      Authorization: `Bearer ${payload.auth.token}`
    }
  });
  const afterLogoutPayload = await afterLogout.json();
  assert(afterLogout.status === 401, 'session must be invalid after logout');
  assert(afterLogoutPayload.error === 'auth_required', 'logout must revoke the token');

  const expiringLogin = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'expira.demo',
      password: 'Quili.Expira!2026'
    })
  });
  const expiringPayload = await expiringLogin.json();
  assert(expiringLogin.ok, 'expiring login must succeed');
  await delay(1300);
  const expiredSession = await fetch(`${apiBase}/api/auth/session`, {
    headers: {
      Authorization: `Bearer ${expiringPayload.auth.token}`
    }
  });
  const expiredPayload = await expiredSession.json();
  assert(expiredSession.status === 401, 'expired session must require re-login');
  assert(expiredPayload.error === 'session_expired', 'expired session must expose structured message');

  if (!process.exitCode) {
    console.log('ui login http pass');
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
