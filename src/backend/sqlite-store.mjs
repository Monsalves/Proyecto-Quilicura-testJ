import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const SQLITE_STORAGE_RELATIVE_PATH = '../../data/quilicura.sqlite';
export const SQLITE_SCHEMA_VERSION = 'v0039';
export const SQLITE_META_TABLE = 'wf_meta';

export const ROOT_META_FIELDS = [
  'schema_version',
  'phase',
  'sidra_mode',
  'production_data',
  'safe_mode',
  'app_contract'
];

export const COLLECTION_SPECS = [
  { key: 'permissions', table: 'permissions', primaryKey: ['id'] },
  { key: 'roles', table: 'roles', primaryKey: ['id'] },
  { key: 'establishments', table: 'establishments', primaryKey: ['id'] },
  { key: 'users', table: 'users', primaryKey: ['id'] },
  { key: 'sessions', table: 'sessions', primaryKey: ['id'] },
  { key: 'patients', table: 'patients', primaryKey: ['id'] },
  { key: 'representatives', table: 'representatives', primaryKey: ['id'] },
  { key: 'patient_contacts', table: 'patient_contacts', primaryKey: ['id'] },
  { key: 'contact_preferences', table: 'contact_preferences', primaryKey: ['patient_id'] },
  { key: 'consents', table: 'consents', primaryKey: ['id'] },
  { key: 'slots', table: 'slots', primaryKey: ['id'] },
  { key: 'appointments', table: 'appointments', primaryKey: ['id'] },
  { key: 'waitlist', table: 'waitlist_entries', primaryKey: ['id'] },
  { key: 'waitlist_offers', table: 'waitlist_offers', primaryKey: ['id'] },
  { key: 'waitlist_events', table: 'waitlist_events', primaryKey: ['id'] },
  { key: 'campaigns', table: 'campaigns', primaryKey: ['id'] },
  { key: 'campaign_recipients', table: 'campaign_recipients', primaryKey: ['id'] },
  { key: 'surveys', table: 'surveys', primaryKey: ['id'] },
  { key: 'survey_responses', table: 'survey_responses', primaryKey: ['id'] },
  { key: 'sidra', table: 'sidra_events', primaryKey: ['id'] },
  { key: 'audit', table: 'audit_log', primaryKey: ['row_key'], syntheticKey: true },
  { key: 'legacy_debt', table: 'legacy_debt_items', primitiveList: true },
  { key: 'professionals', table: 'professionals', primaryKey: ['id'] },
  { key: 'services', table: 'services', primaryKey: ['id'] },
  { key: 'agendas', table: 'agendas', primaryKey: ['id'] },
  { key: 'appointment_history', table: 'appointment_history', primaryKey: ['id'] },
  { key: 'agenda_blocks', table: 'agenda_blocks', primaryKey: ['id'] },
  { key: 'contact_templates', table: 'contact_templates', primaryKey: ['id'] },
  { key: 'contact_cases', table: 'contact_cases', primaryKey: ['id'] },
  { key: 'contact_messages', table: 'contact_messages', primaryKey: ['id'] },
  { key: 'sidra_attempts', table: 'sidra_attempts', primaryKey: ['id'] },
  { key: 'monthly_reports', table: 'monthly_reports', primaryKey: ['id'] },
  { key: 'backups_catalog', table: 'backups_catalog', primaryKey: ['id'] }
];

const RESERVED_COLUMNS = new Set(['wf_order_index', 'payload_json']);

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function databasePath(target) {
  return typeof target === 'string' ? resolve(target) : resolve(fileURLToPath(target));
}

export function sqliteStorageLocation() {
  return process.env.QUILICURA_DB_PATH || 'data/quilicura.sqlite';
}

export function schemaOutputPathFor(dbPath) {
  return `${dbPath}.schema.json`;
}

export async function ensureParentDir(targetPath) {
  await mkdir(dirname(targetPath), { recursive: true });
}

export async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function parseLooseJsonDocument(text) {
  const source = String(text || '');
  const start = source.search(/\S/);
  if (start === -1) {
    throw new Error('empty_json_document');
  }
  const opener = source[start];
  const closer = opener === '{' ? '}' : opener === '[' ? ']' : '';
  if (!closer) {
    throw new Error('unsupported_json_document');
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === opener) {
      depth += 1;
      continue;
    }
    if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(source.slice(start, index + 1));
      }
    }
  }
  throw new Error('unterminated_json_document');
}

export async function readLooseJsonFile(targetPath) {
  return parseLooseJsonDocument(await readFile(targetPath, 'utf8'));
}

function hashValue(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function classifyValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return { storageType: 'INTEGER', logicalType: 'boolean' };
  }
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { storageType: 'INTEGER', logicalType: 'integer' }
      : { storageType: 'REAL', logicalType: 'number' };
  }
  if (typeof value === 'string') {
    return { storageType: 'TEXT', logicalType: 'string' };
  }
  return { storageType: 'TEXT', logicalType: 'json' };
}

function mergeColumnTypes(previous, next) {
  if (!previous) {
    return next;
  }
  if (!next) {
    return previous;
  }
  if (previous.logicalType === next.logicalType) {
    return previous;
  }
  if (previous.logicalType === 'json' || next.logicalType === 'json') {
    return { storageType: 'TEXT', logicalType: 'json' };
  }
  if (previous.storageType === 'TEXT' || next.storageType === 'TEXT') {
    return { storageType: 'TEXT', logicalType: 'string' };
  }
  if (previous.storageType === 'REAL' || next.storageType === 'REAL') {
    return { storageType: 'REAL', logicalType: 'number' };
  }
  return { storageType: 'INTEGER', logicalType: 'integer' };
}

function inferColumns(spec, rows) {
  const columns = new Map();
  for (const primaryKey of spec.primaryKey) {
    columns.set(primaryKey, { name: primaryKey, storageType: 'TEXT', logicalType: 'string' });
  }
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      continue;
    }
    for (const [key, value] of Object.entries(row)) {
      if (RESERVED_COLUMNS.has(key)) {
        continue;
      }
      const next = classifyValue(value);
      const previous = columns.get(key);
      const merged = mergeColumnTypes(previous, next);
      if (merged) {
        columns.set(key, { name: key, ...merged });
      }
    }
  }
  return [...columns.values()].sort((left, right) => {
    const leftIndex = spec.primaryKey.indexOf(left.name);
    const rightIndex = spec.primaryKey.indexOf(right.name);
    if (leftIndex !== -1 || rightIndex !== -1) {
      return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex);
    }
    return left.name.localeCompare(right.name);
  });
}

function manifestFromDatabaseObject(db) {
  return {
    schema_version: SQLITE_SCHEMA_VERSION,
    meta_fields: ROOT_META_FIELDS,
    tables: COLLECTION_SPECS.map((spec) => {
      const sourceRows = Array.isArray(db?.[spec.key]) ? db[spec.key] : [];
      return {
        ...spec,
        columns: spec.primitiveList ? [] : inferColumns(spec, sourceRows)
      };
    })
  };
}

function normalizeRecordValue(column, value) {
  if (value === undefined) {
    return null;
  }
  if (value === null) {
    return null;
  }
  switch (column.logicalType) {
    case 'boolean':
      return value ? 1 : 0;
    case 'integer':
    case 'number':
      return typeof value === 'number' ? value : Number(value);
    case 'json':
      return JSON.stringify(value);
    default:
      return String(value);
  }
}

function deserializeRecordValue(column, value) {
  if (value === null || value === undefined) {
    return null;
  }
  switch (column.logicalType) {
    case 'boolean':
      return Boolean(value);
    case 'integer':
    case 'number':
      return value;
    case 'json':
      return JSON.parse(value);
    default:
      return value;
  }
}

function syntheticKeyFor(spec, row, index) {
  if (!spec.syntheticKey) {
    return null;
  }
  if (row && typeof row === 'object' && row.row_key) {
    return row.row_key;
  }
  return `${spec.key}-${String(index).padStart(6, '0')}-${hashValue(row)}`;
}

function openDatabase(dbPath) {
  const database = new DatabaseSync(dbPath);
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec('PRAGMA foreign_keys = OFF;');
  return database;
}

function createMetaTable(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(SQLITE_META_TABLE)} (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);`);
}

function writeMeta(database, manifest, db) {
  const statement = database.prepare(
    `INSERT INTO ${quoteIdentifier(SQLITE_META_TABLE)} (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json;`
  );
  statement.run('schema_manifest', JSON.stringify(manifest));
  statement.run('table_counts', JSON.stringify(Object.fromEntries(manifest.tables.map((table) => [table.table, Array.isArray(db?.[table.key]) ? db[table.key].length : 0]))));
  statement.run('updated_at', JSON.stringify(new Date().toISOString()));
  for (const key of ROOT_META_FIELDS) {
    statement.run(key, JSON.stringify(db?.[key] ?? null));
  }
}

function createTable(database, tableManifest) {
  if (tableManifest.primitiveList) {
    database.exec(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableManifest.table)} (
        row_key TEXT PRIMARY KEY,
        wf_order_index INTEGER NOT NULL,
        value_text TEXT NOT NULL
      );`
    );
    return;
  }
  const columnSql = tableManifest.columns.map((column) => `${quoteIdentifier(column.name)} ${column.storageType}`).join(',\n        ');
  const primaryKeySql = tableManifest.primaryKey.map(quoteIdentifier).join(', ');
  database.exec(
    `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableManifest.table)} (
        ${columnSql},
        wf_order_index INTEGER NOT NULL,
        payload_json TEXT,
        PRIMARY KEY (${primaryKeySql})
      );`
  );
}

function insertRows(database, tableManifest, rows) {
  database.exec(`DELETE FROM ${quoteIdentifier(tableManifest.table)};`);
  if (tableManifest.primitiveList) {
    const statement = database.prepare(
      `INSERT INTO ${quoteIdentifier(tableManifest.table)} (row_key, wf_order_index, value_text) VALUES (?, ?, ?);`
    );
    rows.forEach((item, index) => {
      statement.run(`${tableManifest.key}-${String(index).padStart(4, '0')}`, index, String(item ?? ''));
    });
    return;
  }
  const columnNames = tableManifest.columns.map((column) => column.name);
  const statement = database.prepare(
    `INSERT INTO ${quoteIdentifier(tableManifest.table)} (${columnNames.map(quoteIdentifier).join(', ')}, wf_order_index, payload_json)
     VALUES (${columnNames.map(() => '?').join(', ')}, ?, ?);`
  );
  rows.forEach((rawRow, index) => {
    const row = rawRow && typeof rawRow === 'object' && !Array.isArray(rawRow) ? { ...rawRow } : {};
    if (tableManifest.syntheticKey) {
      row.row_key = syntheticKeyFor(tableManifest, row, index);
    }
    const extras = {};
    const values = tableManifest.columns.map((column) => {
      const value = row[column.name];
      return normalizeRecordValue(column, value);
    });
    for (const [key, value] of Object.entries(row)) {
      if (!columnNames.includes(key) && !RESERVED_COLUMNS.has(key)) {
        extras[key] = value;
      }
    }
    statement.run(...values, index, Object.keys(extras).length ? JSON.stringify(extras) : null);
  });
}

function readManifest(database) {
  createMetaTable(database);
  const row = database.prepare(`SELECT value_json FROM ${quoteIdentifier(SQLITE_META_TABLE)} WHERE key = ?;`).get('schema_manifest');
  if (!row?.value_json) {
    throw new Error('sqlite_schema_manifest_missing');
  }
  return JSON.parse(row.value_json);
}

function loadMeta(database, key) {
  const row = database.prepare(`SELECT value_json FROM ${quoteIdentifier(SQLITE_META_TABLE)} WHERE key = ?;`).get(key);
  return row?.value_json ? JSON.parse(row.value_json) : null;
}

export async function createSqliteDatabase(target, db, options = {}) {
  const dbPath = databasePath(target);
  const manifest = manifestFromDatabaseObject(db);
  await ensureParentDir(dbPath);
  if (options.overwrite !== false) {
    await rm(dbPath, { force: true });
    await rm(schemaOutputPathFor(dbPath), { force: true });
  }
  const database = openDatabase(dbPath);
  try {
    database.exec('BEGIN IMMEDIATE;');
    createMetaTable(database);
    for (const tableManifest of manifest.tables) {
      createTable(database, tableManifest);
      insertRows(database, tableManifest, Array.isArray(db?.[tableManifest.key]) ? db[tableManifest.key] : []);
    }
    writeMeta(database, manifest, db);
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
    }
    throw error;
  } finally {
    database.close();
  }
  await writeFile(schemaOutputPathFor(dbPath), `${JSON.stringify({
    manifest,
    source: options.source || null
  }, null, 2)}\n`, 'utf8');
  return inspectSqliteDatabase(dbPath);
}

export function loadSqliteDatabase(target) {
  const dbPath = databasePath(target);
  const database = openDatabase(dbPath);
  try {
    const manifest = readManifest(database);
    const db = Object.fromEntries(ROOT_META_FIELDS.map((key) => [key, loadMeta(database, key)]));
    for (const tableManifest of manifest.tables) {
      if (tableManifest.primitiveList) {
        const rows = database.prepare(
          `SELECT value_text FROM ${quoteIdentifier(tableManifest.table)} ORDER BY wf_order_index ASC;`
        ).all();
        db[tableManifest.key] = rows.map((row) => row.value_text);
        continue;
      }
      const rows = database.prepare(
        `SELECT * FROM ${quoteIdentifier(tableManifest.table)} ORDER BY wf_order_index ASC;`
      ).all();
      db[tableManifest.key] = rows.map((row) => {
        const record = {};
        for (const column of tableManifest.columns) {
          const value = deserializeRecordValue(column, row[column.name]);
          if (value !== null) {
            record[column.name] = value;
          } else if (Object.prototype.hasOwnProperty.call(row, column.name)) {
            record[column.name] = null;
          }
        }
        if (row.payload_json) {
          Object.assign(record, JSON.parse(row.payload_json));
        }
        return record;
      });
    }
    return db;
  } finally {
    database.close();
  }
}

export async function saveSqliteDatabase(target, db) {
  const dbPath = databasePath(target);
  const exists = await fileExists(dbPath);
  if (!exists) {
    return createSqliteDatabase(dbPath, db, { source: 'runtime_save' });
  }
  const database = openDatabase(dbPath);
  try {
    const manifest = readManifest(database);
    database.exec('BEGIN IMMEDIATE;');
    for (const tableManifest of manifest.tables) {
      insertRows(database, tableManifest, Array.isArray(db?.[tableManifest.key]) ? db[tableManifest.key] : []);
    }
    writeMeta(database, manifest, db);
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
    }
    throw error;
  } finally {
    database.close();
  }
  const database2 = openDatabase(dbPath);
  try {
    const manifest = readManifest(database2);
    await writeFile(schemaOutputPathFor(dbPath), `${JSON.stringify({ manifest, source: 'runtime_save' }, null, 2)}\n`, 'utf8');
  } finally {
    database2.close();
  }
  return inspectSqliteDatabase(dbPath);
}

export function inspectSqliteDatabase(target) {
  const dbPath = databasePath(target);
  const database = openDatabase(dbPath);
  try {
    const manifest = readManifest(database);
    const tables = manifest.tables.map((tableManifest) => {
      const row = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableManifest.table)};`).get();
      return {
        key: tableManifest.key,
        table: tableManifest.table,
        rows: row?.count || 0,
        primary_key: tableManifest.primaryKey,
        primitive_list: Boolean(tableManifest.primitiveList)
      };
    });
    return {
      status: 'pass',
      db_path: dbPath,
      schema_path: schemaOutputPathFor(dbPath),
      schema_version: manifest.schema_version,
      table_count: tables.length + 1,
      tables: [
        ...tables,
        { key: 'wf_meta', table: SQLITE_META_TABLE, rows: database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(SQLITE_META_TABLE)};`).get()?.count || 0 }
      ]
    };
  } finally {
    database.close();
  }
}
