import {
  createBackupV1,
  createMonthlyReportV1,
  createPatientV1,
  exportMonthlyReportV1,
  getPatientV1,
  listAudit,
  listBackupsV1,
  listMonthlyReportsV1,
  loginUser,
  resetDatabaseForUser,
  restoreBackupV1
} from '../src/backend/local-backend.mjs';

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

let backupId = null;

try {
  const initialAdmin = await loginUser('admin.comunal', 'Quili.Admin!2026');
  assert(initialAdmin.status === 200, 'reports api initial admin login must succeed');

  const reset = await resetDatabaseForUser(initialAdmin.auth.token);
  assert(reset.status === 200, 'reports api reset must succeed');

  const adminLogin = await loginUser('admin.comunal', 'Quili.Admin!2026');
  const gestorLogin = await loginUser('gestor.cesfam', 'Quili.Gestor!2026');
  const professionalLogin = await loginUser('profesional.demo', 'Quili.Pro!2026');
  assert(adminLogin.status === 200, 'reports api admin login must succeed');
  assert(gestorLogin.status === 200, 'reports api gestor login must succeed');
  assert(professionalLogin.status === 200, 'reports api professional login must succeed');

  const deniedReport = await listMonthlyReportsV1(professionalLogin.auth.token);
  assert(deniedReport.status === 403, 'professional monthly report access must be denied');

  const createReport = await createMonthlyReportV1(gestorLogin.auth.token, {
    period: '2026-07',
    establishment_id: 'cesfam-bauza',
    channel: 'sms'
  });
  assert(createReport.status === 201, 'gestor monthly report create must succeed');
  assert(createReport.payload.report?.period === '2026-07', 'monthly report must keep requested period');
  assert(createReport.payload.report?.privacy?.identifiable_export === false, 'monthly report must remain aggregate only');

  const exportDenied = await exportMonthlyReportV1(gestorLogin.auth.token, {
    period: '2026-07',
    purpose: 'seguimiento_operativo'
  });
  assert(exportDenied.status === 403, 'gestor report export must be denied without reports.export');

  const exportBlocked = await exportMonthlyReportV1(adminLogin.auth.token, {
    period: '2026-07',
    purpose: 'seguimiento_operativo',
    identifiable: true
  });
  assert(exportBlocked.status === 422, 'identifiable report export must be blocked');

  const exportAggregate = await exportMonthlyReportV1(adminLogin.auth.token, {
    period: '2026-07',
    purpose: 'seguimiento_operativo',
    establishment_id: 'cesfam-bauza'
  });
  assert(exportAggregate.status === 200, 'admin aggregate report export must succeed');
  assert(exportAggregate.payload.export?.identifiable === false, 'aggregate report export must stay non-identifiable');

  const auditFiltered = await listAudit(adminLogin.auth.token, {
    action: 'report.monthly.export.aggregate',
    limit: '5'
  });
  assert(auditFiltered.status === 200, 'filtered audit query must succeed');
  assert((auditFiltered.payload.items || []).some((item) => item.action === 'report.monthly.export.aggregate'), 'filtered audit must include report export action');

  const createBackup = await createBackupV1(adminLogin.auth.token, {
    label: 'pre-restore-r09',
    note: 'Snapshot previo a crear paciente temporal'
  });
  assert(createBackup.status === 201, 'backup create must succeed');
  backupId = createBackup.payload.backup?.id;
  assert(Boolean(backupId), 'backup create must return id');

  const listBackups = await listBackupsV1(adminLogin.auth.token);
  assert(listBackups.status === 200, 'backup list must succeed');
  assert((listBackups.payload.items || []).some((item) => item.id === backupId), 'backup list must include created backup');

  const createdPatient = await createPatientV1(adminLogin.auth.token, {
    identifier_kind: 'transient',
    transient_reason: 'Sin documento durante prueba de restore',
    legal_name: 'Paciente Restore Temporal',
    social_name: 'Paciente Restore',
    birth_date: '1989-03-20',
    establishment_id: 'cesfam-quilicura',
    sector: 'Sector 4',
    risk: 'seguimiento',
    notes: 'Paciente temporal para validar restore'
  });
  assert(createdPatient.status === 201, 'temporary patient create must succeed');
  const createdPatientId = createdPatient.payload.patient?.id;
  assert(Boolean(createdPatientId), 'temporary patient id must exist');

  const restore = await restoreBackupV1(adminLogin.auth.token, {
    backup_id: backupId
  });
  assert(restore.status === 200, 'backup restore must succeed');

  const relogin = await loginUser('admin.comunal', 'Quili.Admin!2026');
  assert(relogin.status === 200, 'admin relogin after restore must succeed');

  const missingPatient = await getPatientV1(relogin.auth.token, createdPatientId);
  assert(missingPatient.status === 404, 'restored snapshot must remove temporary patient');

  const reportsAfterPersistence = await listMonthlyReportsV1(relogin.auth.token, { period: '2026-07' });
  assert(reportsAfterPersistence.status === 200, 'monthly reports list after persistence must succeed');
  assert((reportsAfterPersistence.payload.items || []).some((item) => item.period === '2026-07'), 'monthly reports must persist');

  if (!process.exitCode) {
    console.log('reports api pass');
  }
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
