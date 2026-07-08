import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = new URL('.', import.meta.url);
const workspaceRoot = resolve(fileURLToPath(scriptDir), '..');
const projectRoot = resolve(workspaceRoot, '..', '..', '..');
const qaWorkspaceRoot = join(projectRoot, 'sandboxes', 'QA', 'workspace');
const runtime = JSON.parse(await readFile(join(workspaceRoot, 'config', 'operational.json'), 'utf8'));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const qaRuntime = JSON.parse(await readFile(join(qaWorkspaceRoot, 'config', 'operational.json'), 'utf8'));
process.env.QUILICURA_DB_PATH = join(qaWorkspaceRoot, qaRuntime.storage.path);
process.env.QUILICURA_RUNTIME_PATH = join(qaWorkspaceRoot, 'config', 'operational.json');
process.env.QUILICURA_BACKUPS_DIR = join(qaWorkspaceRoot, 'data', 'backups');

const backendModule = await import(pathToFileURL(join(qaWorkspaceRoot, 'src', 'backend', 'local-backend.mjs')).href);

try {
  const login = await backendModule.loginUser('admin.comunal', 'Quili.Admin!2026');
  assert(login.status === 200, 'qa smoke admin login must succeed');

  const bootstrap = await backendModule.getBootstrap(login.auth.token);
  assert(bootstrap.status === 200, 'qa smoke bootstrap must succeed');
  assert(bootstrap.payload.runtime?.version === runtime.version, 'qa smoke bootstrap runtime version must match');
  assert(bootstrap.payload.runtime?.sidra_mode === 'simulated', 'qa smoke sidra_mode must remain simulated');

  const reports = await backendModule.listMonthlyReportsV1(login.auth.token, { period: '2026-07' });
  assert(reports.status === 200, 'qa smoke monthly reports must succeed');

  console.log('qa smoke pass');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
