import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { inspectSqliteDatabase, loadSqliteDatabase } from '../src/backend/sqlite-store.mjs';

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function digest(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function runGenerator(outputDir) {
  const seedPath = join(outputDir, 'seed-v0031.json');
  const dbPath = join(outputDir, 'quilicura.sqlite');
  const child = spawn(process.execPath, [
    'scripts/generate-local-seed.mjs',
    '--input',
    'data/seed-r11-base.json',
    '--seed-output',
    seedPath,
    '--db-output',
    dbPath
  ], {
    cwd: workspaceRoot,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  await new Promise((resolvePromise, rejectPromise) => {
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(stderr || `seed generator failed with code ${code}`));
    });
    child.on('error', rejectPromise);
  });

  const seedText = JSON.stringify(loadSqliteDatabase(dbPath));

  return {
    seedText,
    db: loadSqliteDatabase(dbPath),
    inspect: inspectSqliteDatabase(dbPath)
  };
}

const firstRunDir = await mkdtemp(join(tmpdir(), 'quilicura-seed-v0031-a-'));
const secondRunDir = await mkdtemp(join(tmpdir(), 'quilicura-seed-v0031-b-'));

try {
  const first = await runGenerator(firstRunDir);
  const second = await runGenerator(secondRunDir);

  assert(digest(first.seedText) === digest(second.seedText), 'sqlite-reloaded db output must be deterministic');

  assert(first.db.patients.length >= 100, 'seed must contain at least 100 patients');
  assert(first.db.appointments.length >= 120, 'seed must contain at least 120 appointments');
  assert(first.db.waitlist.length >= 40, 'seed must contain at least 40 waitlist rows');
  assert(first.db.contact_cases.length >= 60, 'seed must contain at least 60 contact cases');
  assert(first.db.sidra.length >= 20, 'seed must contain at least 20 sidra events');
  assert(Array.isArray(first.db.sessions) && first.db.sessions.length === 0, 'seed reset db must start without sessions');
  assert(first.inspect.table_count >= 30, 'sqlite seed reset must create real tables');
  assert(new Set(first.db.patients.map((item) => item.rut).filter(Boolean)).size >= 90, 'seed must contain diverse patient RUT values');
  assert(new Set(first.db.patients.map((item) => item.legal_name).filter(Boolean)).size >= 90, 'seed must contain diverse patient names');

  console.log(JSON.stringify({
    status: 'pass',
    counts: {
      tables: first.inspect.table_count,
      patients: first.db.patients.length,
      appointments: first.db.appointments.length,
      waitlist: first.db.waitlist.length,
      contact_cases: first.db.contact_cases.length,
      sidra: first.db.sidra.length
    }
  }, null, 2));
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  await rm(firstRunDir, { recursive: true, force: true });
  await rm(secondRunDir, { recursive: true, force: true });
}
