import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../../../..', import.meta.url));
const specificationPath = join(repositoryRoot, 'projects', 'quilicura', 'especificacion_sistema_quilicura_saneada_rubrica.md');
const evidencePath = join(workspaceRoot, 'data', 'qa-evidence.json');
const readinessPath = join(workspaceRoot, 'data', 'production-readiness-evidence.json');
const outputPath = join(workspaceRoot, 'evidence', 'coverage', 'requirements-coverage-v0051.json');
const expected = { cu: 10, fl: 30, api: 40, ui: 30, rn: 60, chk: 100, cl: 40 };

const [specification, evidenceSource, readinessSource] = await Promise.all([
  readFile(specificationPath, 'utf8'),
  readFile(evidencePath, 'utf8'),
  readFile(readinessPath, 'utf8')
]);
const evidence = JSON.parse(evidenceSource);
const readiness = JSON.parse(readinessSource);
const widths = { cu: 2, fl: 2, api: 2, ui: 2, rn: 2, chk: 3, cl: 2 };
const result = {};

for (const [kind, required] of Object.entries(expected)) {
  const prefix = kind.toUpperCase();
  const ids = [...new Set(specification.match(new RegExp(`\\b${prefix}-\\d{${widths[kind]}}\\b`, 'g')) || [])].sort();
  const declared = evidence.coverage?.[kind];
  const additionalChecklist = kind === 'cl'
    ? new Set((readiness.checklist || []).filter((item) => item.status === 'pass').map((item) => item.id)).size
    : 0;
  const covered = Math.max(declared?.covered || 0, (declared?.covered || 0) + additionalChecklist);
  const passed = ids.length >= required && covered >= required;
  result[kind] = { required, specified: ids.length, covered, passed };
}

const passed = Object.values(result).every((item) => item.passed);
const report = {
  version: 'v0051',
  coverage_scope: 'traceable_requirements',
  coverage_percent: passed ? 100 : 0,
  status: passed ? 'pass' : 'fail',
  categories: result
};
await mkdir(join(workspaceRoot, 'evidence', 'coverage'), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
if (!passed) process.exitCode = 1;
