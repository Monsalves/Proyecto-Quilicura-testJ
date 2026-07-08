import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createSqliteDatabase,
  inspectSqliteDatabase,
  parseLooseJsonDocument,
  sqliteStorageLocation
} from '../src/backend/sqlite-store.mjs';

function parseArgs(argv) {
  const options = {
    command: argv[0] || 'inspect',
    input: null,
    dbOutput: sqliteStorageLocation(),
    seedOutput: null,
    summary: false
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') {
      options.input = argv[index + 1];
      index += 1;
    } else if (arg === '--db-output') {
      options.dbOutput = argv[index + 1];
      index += 1;
    } else if (arg === '--seed-output') {
      options.seedOutput = argv[index + 1];
      index += 1;
    } else if (arg === '--summary') {
      options.summary = true;
    }
  }
  return options;
}

async function loadJsonSource(inputPath) {
  if (!inputPath) {
    throw new Error('sqlite_db_input_required');
  }
  return parseLooseJsonDocument(await readFile(resolve(inputPath), 'utf8'));
}

const options = parseArgs(process.argv.slice(2));

if (options.command === 'inspect') {
  console.log(JSON.stringify(inspectSqliteDatabase(resolve(options.dbOutput)), null, 2));
  process.exit(0);
}

if (!['init', 'seed', 'reset', 'import-json'].includes(options.command)) {
  throw new Error(`unsupported_command:${options.command}`);
}

const sourceDb = await loadJsonSource(options.input);

if (options.seedOutput) {
  await writeFile(resolve(options.seedOutput), `${JSON.stringify(sourceDb, null, 2)}\n`, 'utf8');
}

const report = await createSqliteDatabase(resolve(options.dbOutput), sourceDb, {
  source: resolve(options.input)
});

if (options.summary) {
  console.log(JSON.stringify(report, null, 2));
}
