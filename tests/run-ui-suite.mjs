import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const scripts = [
  'test:ui', 'test:ui-rbac', 'test:ui-patients', 'test:ui-agenda',
  'test:ui-waitlist', 'test:ui-contact', 'test:ui-campaigns',
  'test:ui-sidra', 'test:ui-reports'
];
const startedAt = Date.now();

for (const script of scripts) {
  const testStartedAt = Date.now();
  const code = await new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', script], { stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) {
    console.error(`UI suite failed at ${script}`);
    process.exitCode = code;
    break;
  }
  console.log(`${script} completed in ${Date.now() - testStartedAt}ms`);
  await delay(400);
}

if (!process.exitCode) console.log(`UI suite pass in ${Date.now() - startedAt}ms`);
