import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const runtime = JSON.parse(await readFile(new URL('../config/operational.json', import.meta.url), 'utf8'));
const versionRoot = join(projectRoot, 'versions', runtime.version);
const qaWorkspaceRoot = join(projectRoot, 'sandboxes', 'QA', 'workspace');
const manifestPath = join(versionRoot, 'version-manifest.json');
const evidencePath = new URL(`../evidence/versioning/dev-to-version-to-qa-promotion-${runtime.version}.json`, import.meta.url);

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

async function runNodeScript(relativePath) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [relativePath], {
      cwd: workspaceRoot,
      stdio: 'inherit'
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${relativePath} exited with code ${code}`));
    });
    child.on('error', rejectPromise);
  });
}

async function sha256(path) {
  const content = await readFile(path);
  return createHash('sha256').update(content).digest('hex');
}

try {
  await runNodeScript('scripts/promote-version.mjs');

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  assert(manifest.version === runtime.version, 'version manifest must match runtime version');
  assert(manifest.phase === runtime.phase, 'version manifest must match runtime phase');
  assert(manifest.file_count > 20, 'version manifest must include substantive snapshot content');
  assert(evidence.version === runtime.version, 'workspace promotion evidence must match runtime version');

  const requiredFiles = [
    'README.md',
    'package.json',
    'config/operational.json',
    'src/backend/server.mjs',
    'src/backend/local-backend.mjs',
    'tests/verify.mjs'
  ];

  for (const relativePath of requiredFiles) {
    const manifestEntry = manifest.files.find((item) => item.path === relativePath);
    assert(Boolean(manifestEntry), `version manifest must include ${relativePath}`);
    if (!manifestEntry) {
      continue;
    }
    const versionFile = join(versionRoot, relativePath);
    const qaFile = join(qaWorkspaceRoot, relativePath);
    const devFile = join(workspaceRoot, relativePath);
    await stat(versionFile);
    await stat(qaFile);
    const [devHash, versionHash, qaHash] = await Promise.all([
      sha256(devFile),
      sha256(versionFile),
      sha256(qaFile)
    ]);
    assert(devHash === manifestEntry.sha256, `${relativePath} hash in DEV must match manifest`);
    assert(versionHash === manifestEntry.sha256, `${relativePath} hash in version snapshot must match manifest`);
    assert(qaHash === manifestEntry.sha256, `${relativePath} hash in QA must match manifest`);
  }

  await runNodeScript('scripts/smoke-local-package.mjs');
  await delay(100);

  if (!process.exitCode) {
    console.log('version promotion pass');
  }
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
