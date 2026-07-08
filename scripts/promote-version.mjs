import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const workspaceRoot = resolve(scriptDir, '..');
const projectRoot = resolve(workspaceRoot, '..', '..', '..');
const qaWorkspaceRoot = join(projectRoot, 'sandboxes', 'QA', 'workspace');
const runtime = JSON.parse(await readFile(join(workspaceRoot, 'config', 'operational.json'), 'utf8'));
const versionRoot = join(projectRoot, 'versions', runtime.version);
const evidencePath = join(workspaceRoot, 'evidence', 'versioning', `dev-to-version-to-qa-promotion-${runtime.version}.json`);

const IGNORED_PREFIXES = ['.factory-runtime/', 'data/backups/'];
const IGNORED_FILES = new Set([`evidence/versioning/dev-to-version-to-qa-promotion-${runtime.version}.json`]);

function shouldIgnore(relativePath) {
  return IGNORED_PREFIXES.some((prefix) => relativePath.startsWith(prefix)) || IGNORED_FILES.has(relativePath);
}

async function listFiles(root, current = root, collector = []) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    const relativePath = relative(root, absolutePath).replaceAll('\\', '/');
    if (shouldIgnore(relativePath)) {
      continue;
    }
    if (entry.isDirectory()) {
      await listFiles(root, absolutePath, collector);
      continue;
    }
    collector.push(relativePath);
  }
  return collector;
}

async function sha256(path) {
  const content = await readFile(path);
  return createHash('sha256').update(content).digest('hex');
}

async function buildManifest(snapshotRoot) {
  const files = await listFiles(snapshotRoot);
  const fileEntries = [];
  for (const file of files) {
    const absolutePath = join(snapshotRoot, file);
    const fileStat = await stat(absolutePath);
    fileEntries.push({
      path: file,
      bytes: fileStat.size,
      sha256: await sha256(absolutePath)
    });
  }
  return {
    project_id: 'quilicura-salud-web',
    phase: runtime.phase,
    version: runtime.version,
    generated_at: new Date().toISOString(),
    source_workspace: relative(projectRoot, workspaceRoot).replaceAll('\\', '/'),
    snapshot_root: relative(projectRoot, snapshotRoot).replaceAll('\\', '/'),
    qa_workspace: relative(projectRoot, qaWorkspaceRoot).replaceAll('\\', '/'),
    ignores: [...IGNORED_PREFIXES, ...IGNORED_FILES],
    file_count: fileEntries.length,
    files: fileEntries
  };
}

async function copyWorkspaceSnapshot(destinationRoot) {
  await rm(destinationRoot, { recursive: true, force: true });
  await mkdir(destinationRoot, { recursive: true });
  await cp(workspaceRoot, destinationRoot, {
    recursive: true,
    filter: (source) => {
      const rel = relative(workspaceRoot, source).replaceAll('\\', '/');
      if (!rel) {
        return true;
      }
      return !shouldIgnore(rel);
    }
  });
}

await copyWorkspaceSnapshot(versionRoot);
const manifest = await buildManifest(versionRoot);
await writeFile(join(versionRoot, 'version-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
await rm(qaWorkspaceRoot, { recursive: true, force: true });
await mkdir(qaWorkspaceRoot, { recursive: true });
await cp(versionRoot, qaWorkspaceRoot, { recursive: true });
await mkdir(join(workspaceRoot, 'evidence', 'versioning'), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  promoted_version: runtime.version,
  phase: runtime.phase,
  snapshot_root: manifest.snapshot_root,
  qa_workspace: manifest.qa_workspace,
  file_count: manifest.file_count
}, null, 2));
