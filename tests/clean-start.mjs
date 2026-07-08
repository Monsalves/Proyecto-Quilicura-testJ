import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const tempRoot = await mkdtemp(join(tmpdir(), 'quilicura-clean-start-'));
const dbPath = join(tempRoot, 'quilicura.sqlite');
const backupsDir = join(tempRoot, 'backups');
const runtimePath = join(tempRoot, 'operational.json');
const generatedSeedPath = join(tempRoot, 'seed-v0031.json');

try {
  await mkdir(backupsDir, { recursive: true });
  const seedGenerator = spawn(process.execPath, [
    'scripts/generate-local-seed.mjs',
    '--input',
    'data/seed-r11-base.json',
    '--seed-output',
    generatedSeedPath,
    '--db-output',
    dbPath
  ], {
    cwd: workspaceRoot,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolvePromise, rejectPromise) => {
    seedGenerator.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`seed generator failed with code ${code}`));
    });
    seedGenerator.on('error', rejectPromise);
  });
  const runtime = JSON.parse(await readFile(new URL('../config/operational.json', import.meta.url), 'utf8'));
  runtime.storage.path = dbPath;
  runtime.storage.seed = 'data/seed-v0031.json';
  runtime.storage.engine = 'sqlite';
  await writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`, 'utf8');
  process.env.QUILICURA_DB_PATH = dbPath;
  process.env.QUILICURA_BACKUPS_DIR = backupsDir;
  process.env.QUILICURA_RUNTIME_PATH = runtimePath;

  const [{ ensureOperationalSeed }, backendModule] = await Promise.all([
    import('../src/backend/seed-bootstrap.mjs'),
    import('../src/backend/local-backend.mjs')
  ]);

  await ensureOperationalSeed(runtime);
  const loadedRuntime = await backendModule.loadRuntime();
  assert(loadedRuntime.version === runtime.version, 'clean-start runtime version must match');

  const login = await backendModule.loginUser('admin.comunal', 'Quili.Admin!2026');
  assert(login.status === 200, 'clean-start login must succeed');

  const bootstrap = await backendModule.getBootstrap(login.auth.token);
  assert(bootstrap.status === 200, 'clean-start bootstrap must succeed');
  assert(bootstrap.payload.summary?.active_patients >= 1, 'clean-start bootstrap must expose seeded patients');
  console.log('clean-start pass');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
