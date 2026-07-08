import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const workspaceRoot = resolve(scriptDir, '..');
const projectRoot = resolve(workspaceRoot, '..', '..', '..');
const runtime = JSON.parse(await readFile(join(workspaceRoot, 'config', 'operational.json'), 'utf8'));
const targetVersion = process.argv[2] || runtime.version;
const snapshotRoot = join(projectRoot, 'versions', targetVersion);
const qaWorkspaceRoot = join(projectRoot, 'sandboxes', 'QA', 'workspace');

await rm(qaWorkspaceRoot, { recursive: true, force: true });
await mkdir(qaWorkspaceRoot, { recursive: true });
await cp(snapshotRoot, qaWorkspaceRoot, { recursive: true });

console.log(JSON.stringify({
  restored_version: targetVersion,
  target: 'QA',
  source_snapshot: `project/quilicura-salud-web/versions/${targetVersion}`,
  destination: 'project/quilicura-salud-web/sandboxes/QA/workspace'
}, null, 2));
