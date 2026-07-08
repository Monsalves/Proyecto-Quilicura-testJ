import {
  approveCampaignV1,
  createCampaignV1,
  exportCampaignMetricsV1,
  getCampaignMetricsV1,
  loginUser,
  recordSurveyResponseV1,
  resetDatabaseForUser,
  scheduleCampaignV1
} from '../src/backend/local-backend.mjs';

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

let createdCampaignId = null;

try {
  const initialAdmin = await loginUser('admin.comunal', 'Quili.Admin!2026');
  assert(initialAdmin.status === 200, 'campaign api initial admin login must succeed');

  const reset = await resetDatabaseForUser(initialAdmin.auth.token);
  assert(reset.status === 200, 'campaign api reset must succeed');

  const adminLogin = await loginUser('admin.comunal', 'Quili.Admin!2026');
  const gestorLogin = await loginUser('gestor.cesfam', 'Quili.Gestor!2026');
  const professionalLogin = await loginUser('profesional.demo', 'Quili.Pro!2026');
  assert(adminLogin.status === 200, 'campaign api admin login must succeed');
  assert(gestorLogin.status === 200, 'campaign api gestor login must succeed');
  assert(professionalLogin.status === 200, 'campaign api professional login must succeed');

  const createDenied = await createCampaignV1(professionalLogin.auth.token, {
    name: 'Campana no autorizada',
    purpose: 'contactabilidad_preventiva',
    channel: 'sms',
    audience: 'Segmento bloqueado',
    establishment_id: 'cesfam-bauza',
    template_id: 'TPL-0004'
  });
  assert(createDenied.status === 403, 'professional campaign create must be denied');
  assert(createDenied.error === 'permission_denied', 'professional campaign denial must be structured');

  const missingPurpose = await createCampaignV1(gestorLogin.auth.token, {
    name: 'Campana sin finalidad',
    channel: 'sms',
    audience: 'Pacientes cronicos',
    establishment_id: 'cesfam-bauza',
    template_id: 'TPL-0004'
  });
  assert(missingPurpose.status === 422, 'campaign without purpose must be blocked');

  const created = await createCampaignV1(gestorLogin.auth.token, {
    name: 'Campana preventiva API',
    purpose: 'contactabilidad_preventiva',
    channel: 'sms',
    audience: 'Pacientes cronicos con consentimiento vigente',
    establishment_id: 'cesfam-bauza',
    template_id: 'TPL-0004'
  });
  assert(created.status === 201, 'campaign create must succeed');
  createdCampaignId = created.payload.campaign?.id;
  assert(Boolean(createdCampaignId), 'campaign create must return campaign id');

  const approved = await approveCampaignV1(gestorLogin.auth.token, createdCampaignId, {
    approval_note: 'Aprobacion local para prueba API R08'
  });
  assert(approved.status === 200, 'campaign approval must succeed');

  const scheduled = await scheduleCampaignV1(gestorLogin.auth.token, createdCampaignId, {
    scheduled_at: '2030-07-18T10:30:00.000Z',
    execution_note: 'Programacion local controlada'
  });
  assert(scheduled.status === 200, 'campaign schedule must succeed');
  assert((scheduled.payload.metrics?.delivered || 0) >= 1, 'campaign schedule must produce at least one eligible recipient');

  const exportDenied = await exportCampaignMetricsV1(gestorLogin.auth.token, createdCampaignId, {
    purpose: 'seguimiento_operativo'
  });
  assert(exportDenied.status === 403, 'gestor aggregate export must be denied without campaigns.export');

  const identifiableBlocked = await exportCampaignMetricsV1(adminLogin.auth.token, 'CAM-22', {
    purpose: 'seguimiento_operativo',
    identifiable: true
  });
  assert(identifiableBlocked.status === 422, 'identifiable export must stay blocked locally');

  const invalidSurvey = await recordSurveyResponseV1(gestorLogin.auth.token, 'ENC-001', {
    campaign_id: 'CAM-22',
    patient_id: 'P-1004',
    score: 5,
    channel: 'whatsapp',
    clinical_detail: 'No corresponde'
  });
  assert(invalidSurvey.status === 422, 'survey with clinical detail must be blocked');

  const createdResponse = await recordSurveyResponseV1(gestorLogin.auth.token, 'ENC-001', {
    campaign_id: 'CAM-22',
    patient_id: 'P-1004',
    score: 5,
    channel: 'whatsapp',
    comment: 'Muy buena experiencia local'
  });
  assert(createdResponse.status === 201, 'survey response create must succeed');

  const metrics = await getCampaignMetricsV1(adminLogin.auth.token, 'CAM-22');
  assert(metrics.status === 200, 'campaign metrics must succeed');
  assert(metrics.payload.identifiable_export === false, 'campaign metrics must remain aggregate only');
  assert((metrics.payload.metrics?.responded || 0) >= 2, 'campaign metrics must aggregate survey responses');
  assert(!Object.prototype.hasOwnProperty.call(metrics.payload.metrics || {}, 'patient_id'), 'campaign metrics must not expose patient identifiers');

  const aggregateExport = await exportCampaignMetricsV1(adminLogin.auth.token, 'CAM-22', {
    purpose: 'seguimiento_operativo'
  });
  assert(aggregateExport.status === 200, 'admin aggregate export must succeed');
  assert(aggregateExport.payload.export?.identifiable === false, 'aggregate export must remain non-identifiable');

  const relogin = await loginUser('admin.comunal', 'Quili.Admin!2026');
  assert(relogin.status === 200, 'campaign api relogin after persistence must succeed');

  const persistedCampaign = await getCampaignMetricsV1(relogin.auth.token, createdCampaignId);
  assert(persistedCampaign.status === 200, 'persisted created campaign metrics must succeed');
  assert((persistedCampaign.payload.metrics?.delivered || 0) >= 1, 'scheduled campaign deliveries must persist');

  const persistedSurvey = await getCampaignMetricsV1(relogin.auth.token, 'CAM-22');
  assert(persistedSurvey.status === 200, 'persisted survey campaign metrics must succeed');
  assert((persistedSurvey.payload.metrics?.responded || 0) >= 2, 'survey responses must persist');

  if (!process.exitCode) {
    console.log('campaign api contract pass');
  }
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
