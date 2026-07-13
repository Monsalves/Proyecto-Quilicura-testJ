import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createSqliteDatabase,
  fileExists,
  loadSqliteDatabase,
  parseLooseJsonDocument
} from './sqlite-store.mjs';

function overrideUrl(envName, fallbackRelative) {
  const target = process.env[envName];
  if (!target) {
    return new URL(fallbackRelative, import.meta.url);
  }
  return pathToFileURL(resolve(target));
}

const SEED_ARCHIVE_URL = new URL('../../data/seed-v0031.json.gz.b64', import.meta.url);
const BASE_SEED_URL = new URL('../../data/seed-r11-base.json', import.meta.url);
const DATABASE_URL = overrideUrl('QUILICURA_DB_PATH', '../../data/quilicura.sqlite');
const LEGACY_DATABASE_URL = new URL('../../data/local-db.json', import.meta.url);
const WORKSPACE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function seedUrlForRuntime(runtime) {
  return new URL(`../../${runtime?.storage?.seed || 'data/seed-v0031.json'}`, import.meta.url);
}

async function readJsonIfExists(url) {
  try {
    return JSON.parse(await readFile(url, 'utf8'));
  } catch {
    return null;
  }
}

async function readLooseJsonIfExists(url) {
  try {
    return parseLooseJsonDocument(await readFile(url, 'utf8'));
  } catch {
    return null;
  }
}

async function readSqliteIfExists(url) {
  try {
    const dbPath = fileURLToPath(url);
    if (!(await fileExists(dbPath))) {
      return null;
    }
    return loadSqliteDatabase(dbPath);
  } catch {
    return null;
  }
}

async function ensureParent(url) {
  await mkdir(dirname(fileURLToPath(url)), { recursive: true });
}

async function inflateSeedArchive() {
  const archive = await readFile(SEED_ARCHIVE_URL, 'utf8');
  const json = gunzipSync(Buffer.from(archive.trim(), 'base64')).toString('utf8');
  return JSON.parse(json);
}

function isSupportedRuntime(runtime) {
  return /^v00\d+$/.test(String(runtime?.version || ''));
}

function looksLikeOperationalSeed(db) {
  return Boolean(
    db &&
    db.production_data === false &&
    db.sidra_mode === 'simulated' &&
    db.safe_mode?.external_writes === false &&
    db.patients?.length >= 100 &&
    db.appointments?.length >= 120 &&
    db.waitlist?.length >= 40 &&
    db.contact_cases?.length >= 60 &&
    db.sidra?.length >= 20
  );
}

function matchesRuntimeVersion(db, runtime) {
  return (
    String(db?.version || '') === String(runtime?.version || '') ||
    String(db?.phase || '') === String(runtime?.phase || '')
  );
}

function seedMatchesRuntime(seed, runtime) {
  return looksLikeOperationalSeed(seed) && matchesRuntimeVersion(seed, runtime);
}

function normalizeSeedForRuntime(seed, runtime) {
  return {
    ...seed,
    version: runtime.version,
    phase: runtime.phase,
    sidra_mode: runtime.sidra_mode,
    production_data: false,
    safe_mode: {
      ...(seed.safe_mode || {}),
      external_writes: false
    },
    sessions: []
  };
}

async function loadOperationalSeed(runtime) {
  const runtimeSeedUrl = seedUrlForRuntime(runtime);
  const seedFromFile = await readJsonIfExists(runtimeSeedUrl);
  if (seedMatchesRuntime(seedFromFile, runtime)) {
    return {
      seed: seedFromFile,
      runtimeSeedUrl
    };
  }
  if (await fileExists(fileURLToPath(BASE_SEED_URL))) {
    await regenerateOperationalSeed(runtimeSeedUrl);
    const regeneratedSeed = await readJsonIfExists(runtimeSeedUrl);
    if (regeneratedSeed) {
      return {
        seed: regeneratedSeed,
        runtimeSeedUrl
      };
    }
  }
  return {
    seed: await inflateSeedArchive(),
    runtimeSeedUrl
  };
}

async function regenerateOperationalSeed(runtimeSeedUrl) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [
        'scripts/generate-local-seed.mjs',
        '--input',
        'data/seed-r11-base.json',
        '--seed-output',
        fileURLToPath(runtimeSeedUrl),
        '--db-output',
        fileURLToPath(DATABASE_URL)
      ],
      {
        cwd: WORKSPACE_ROOT,
        stdio: ['ignore', 'ignore', 'pipe']
      }
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(stderr.trim() || `seed regeneration failed with code ${code}`));
    });
    child.on('error', rejectPromise);
  });
}

export async function ensureOperationalSeed(runtime) {
  if (!isSupportedRuntime(runtime)) {
    return;
  }

  const currentDb = await readSqliteIfExists(DATABASE_URL);
  if (looksLikeOperationalSeed(currentDb) && matchesRuntimeVersion(currentDb, runtime)) {
    return;
  }

  const { seed, runtimeSeedUrl } = await loadOperationalSeed(runtime);
  const legacyDb = await readLooseJsonIfExists(LEGACY_DATABASE_URL);
  const sourceDb = looksLikeOperationalSeed(legacyDb) ? legacyDb : seed;
  const normalized = normalizeSeedForRuntime(sourceDb, runtime);

  await ensureParent(runtimeSeedUrl);
  await ensureParent(DATABASE_URL);
  await writeFile(runtimeSeedUrl, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await createSqliteDatabase(fileURLToPath(DATABASE_URL), normalized, {
    source: looksLikeOperationalSeed(legacyDb) ? fileURLToPath(LEGACY_DATABASE_URL) : fileURLToPath(runtimeSeedUrl)
  });
}
