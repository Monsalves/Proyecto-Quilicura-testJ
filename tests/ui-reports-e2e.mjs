import { readFile } from 'node:fs/promises';

import {
  createBackupV1,
  createMonthlyReportV1,
  getBootstrap,
  listAudit,
  loginUser,
  resetDatabaseForUser
} from '../src/backend/local-backend.mjs';

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

try {
  const initialAdmin = await loginUser('admin.comunal', 'Quili.Admin!2026');
  assert(initialAdmin.status === 200, 'ui reports initial admin login must succeed');

  const reset = await resetDatabaseForUser(initialAdmin.auth.token);
  assert(reset.status === 200, 'ui reports reset must succeed');
  const token = reset.payload.auth.token;

  const frontendSource = await readFile(new URL('../src/frontend/app.js', import.meta.url), 'utf8');
  assert(frontendSource.includes('Reportes mensuales persistidos'), 'frontend reports copy must exist');
  assert(frontendSource.includes('continuidad'), 'frontend continuity surface must exist');

  const createReport = await createMonthlyReportV1(token, {
    period: '2026-07',
    establishment_id: 'cesfam-quilicura',
    channel: 'telefono'
  });
  assert(createReport.status === 201, 'report create for ui test must succeed');
  const reportId = createReport.payload.report?.id;
  assert(Boolean(reportId), 'report create for ui test must return id');

  const createBackup = await createBackupV1(token, {
    label: 'ui-r09-snapshot',
    note: 'Respaldo desde flujo UI R09'
  });
  assert(createBackup.status === 201, 'backup create for ui test must succeed');
  const backupId = createBackup.payload.backup?.id;
  assert(Boolean(backupId), 'backup create for ui test must return id');

  const bootstrap = await getBootstrap(token);
  assert(bootstrap.status === 200, 'bootstrap must succeed for reports ui test');
  assert((bootstrap.payload.monthly_reports || []).some((item) => item.id === reportId), 'generated report must appear in bootstrap');
  assert((bootstrap.payload.backups || []).some((item) => item.id === backupId), 'generated backup must appear in bootstrap');
  assert(bootstrap.payload.rbac?.view_access?.reports === true, 'reports view must be enabled in bootstrap');
  assert(bootstrap.payload.rbac?.action_access?.backup_manage === true, 'backup manage action must be enabled in bootstrap');

  const audit = await listAudit(token, {
    action: 'continuity.backup.create',
    limit: '5'
  });
  assert(audit.status === 200, 'audit query for reports ui test must succeed');
  assert((audit.payload.items || []).some((item) => item.action === 'continuity.backup.create'), 'audit query must include backup action');

  if (!process.exitCode) {
    console.log('ui reports http pass');
  }
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
