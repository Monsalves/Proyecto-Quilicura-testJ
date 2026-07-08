import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectSqliteDatabase, loadSqliteDatabase } from '../src/backend/sqlite-store.mjs';

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function run(command, args, cwd = workspaceRoot) {
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  await new Promise((resolvePromise, rejectPromise) => {
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(stderr || stdout || `command failed with code ${code}`));
    });
    child.on('error', rejectPromise);
  });

  return { stdout, stderr };
}

const tempRoot = await mkdtemp(join(tmpdir(), 'quilicura-sqlite-test-'));
const seedPath = join(tempRoot, 'seed-v0031.json');
const dbPath = join(tempRoot, 'quilicura.sqlite');

try {
  await run(process.execPath, [
    'scripts/generate-local-seed.mjs',
    '--input',
    'data/seed-r11-base.json',
    '--seed-output',
    seedPath,
    '--db-output',
    dbPath
  ]);

  const inspectReport = inspectSqliteDatabase(dbPath);
  const db = loadSqliteDatabase(dbPath);
  const schemaText = await readFile(`${dbPath}.schema.json`, 'utf8');
  const schema = JSON.parse(schemaText);

  assert(inspectReport.table_count >= 30, 'sqlite database must expose at least 30 real tables');
  assert(inspectReport.tables.some((table) => table.table === 'patients' && table.rows >= 100), 'patients table must be populated');
  assert(inspectReport.tables.some((table) => table.table === 'appointments' && table.rows >= 120), 'appointments table must be populated');
  assert(inspectReport.tables.some((table) => table.table === 'wf_meta'), 'meta table must exist');
  assert(schema.manifest.schema_version === 'v0039', 'schema manifest must track v0039');
  assert(db.patients.length >= 100, 'sqlite loader must reconstruct patients');
  assert(Array.isArray(db.sessions) && db.sessions.length === 0, 'sqlite loader must preserve empty sessions');

  console.log(JSON.stringify({
    status: 'pass',
    sqlite_path: dbPath,
    table_count: inspectReport.table_count,
    patients: db.patients.length,
    appointments: db.appointments.length
  }, null, 2));
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
