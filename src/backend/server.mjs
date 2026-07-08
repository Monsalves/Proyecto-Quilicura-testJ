import http from 'node:http';
import { readFile } from 'node:fs/promises';
import {
  blockSlot,
  cancelAppointmentV1,
  confirmAppointmentV1,
  createWaitlistEntryV1,
  createWaitlistOfferV1,
  createAgendaBlockV1,
  createAgendaV1,
  createAppointmentV1,
  createPatientConsentV1,
  createPatientContactV1,
  createPatientRepresentativeV1,
  createCampaignV1,
  createPatientV1,
  createProfessionalV1,
  createServiceV1,
  createSlotV1,
  getAppointmentV1,
  getBootstrap,
  getCampaignMetricsV1,
  getPatientV1,
  getSessionSnapshot,
  listAgendasV1,
  listAvailabilityV1,
  listAudit,
  listCampaignsV1,
  listPatientAppointmentsV1,
  listPatientConsentsV1,
  listPatientContactsV1,
  listPatients,
  listPatientsV1,
  listWaitlistV1,
  listProfessionalsV1,
  listServicesV1,
  listSurveysV1,
  listSlotsV1,
  loadRuntime,
  loginUser,
  logoutSession,
  rescheduleAppointmentV1,
  resetDatabaseForUser,
  resolveWaitlistOfferV1,
  storageLocation,
  closeWaitlistEntryV1,
  closeContactCaseV1,
  updateAgendaV1,
  createContactTemplateV1,
  updateProfessionalV1,
  updatePatientConsentV1,
  updatePatientContactV1,
  updatePatientPreferencesV1,
  updatePatientRepresentativeV1,
  updatePatientV1,
  listContactMessagesV1,
  listContactTemplatesV1,
  listSidraEventsV1,
  receiveContactWebhookV1,
  recordSurveyResponseV1,
  createSidraEventV1,
  approveCampaignV1,
  processSidraEventV1,
  retrySidraEventV1,
  resolveSidraDiscrepancyV1,
  scheduleCampaignV1,
  sendContactMessageV1,
  updateServiceV1,
  updateSlotV1,
  updateContactTemplateV1,
  exportCampaignMetricsV1,
  listMonthlyReportsV1,
  createMonthlyReportV1,
  exportMonthlyReportV1,
  listBackupsV1,
  createBackupV1,
  restoreBackupV1
} from './local-backend.mjs';
import { ensureOperationalSeed } from './seed-bootstrap.mjs';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

function parseArgs(argv) {
  const args = { port: 4310, serveFrontend: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--port' && argv[index + 1]) {
      args.port = Number(argv[index + 1]);
    }
    if (argv[index] === '--serve-frontend') {
      args.serveFrontend = true;
    }
  }
  return args;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Cache-Control': 'no-store'
  };
}

function json(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders()
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function text(response, status, payload, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': contentType,
    ...corsHeaders()
  });
  response.end(payload);
}

function frontendUrlFor(pathname) {
  if (pathname === '/' || pathname === '/index.html') {
    return new URL('../../index.html', import.meta.url);
  }
  if (pathname.startsWith('/src/frontend/')) {
    return new URL(`../frontend/${pathname.slice('/src/frontend/'.length)}`, import.meta.url);
  }
  return null;
}

function mimeType(pathname) {
  if (pathname === '/' || pathname === '/index.html') {
    return mime['.html'];
  }
  const extension = pathname.slice(pathname.lastIndexOf('.'));
  return mime[extension] || 'text/plain; charset=utf-8';
}

async function serveFrontend(pathname, response) {
  const target = frontendUrlFor(pathname);
  if (!target) {
    text(response, 404, 'not found');
    return;
  }
  try {
    const body = await readFile(target);
    text(response, 200, body, mimeType(pathname));
  } catch {
    text(response, 404, 'not found');
  }
}

function authTokenFrom(request) {
  const header = String(request.headers.authorization || '');
  if (!header.toLowerCase().startsWith('bearer ')) {
    return '';
  }
  return header.slice(7).trim();
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 250_000) {
        reject(new Error('payload_too_large'));
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

async function readJsonBody(request) {
  const body = await readBody(request);
  if (!body.trim()) {
    return {};
  }
  return JSON.parse(body);
}

async function sendAuthResult(response, result) {
  if (!result.ok) {
    json(response, result.status, Object.fromEntries(
      Object.entries(result).filter(([key]) => !['ok', 'status'].includes(key))
    ));
    return true;
  }
  return false;
}

export function createServer(options = {}) {
  const { serveFrontend: enableFrontend = false } = options;
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        const runtime = await loadRuntime();
        json(response, 200, {
          status: 'ok',
          backend: 'local_http',
          version: runtime.version,
          phase: runtime.phase,
          sidra_mode: runtime.sidra_mode,
          authorization: 'rbac',
          storage: storageLocation(),
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readJsonBody(request);
        const result = await loginUser(body.username, body.password);
        json(response, result.status, result.ok ? {
          status: 'ok',
          auth: result.auth,
          user: result.user
        } : {
          error: result.error,
          message: result.message
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/auth/session') {
        const result = await getSessionSnapshot(authTokenFrom(request));
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, 200, result.payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
        const result = await logoutSession(authTokenFrom(request));
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, 200, result.payload);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
        const result = await getBootstrap(authTokenFrom(request));
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, 200, result.payload);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/campanas') {
        const result = await listCampaignsV1(authTokenFrom(request));
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, 200, result.payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/campanas') {
        const body = await readJsonBody(request);
        const result = await createCampaignV1(authTokenFrom(request), body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/encuestas') {
        const result = await listSurveysV1(authTokenFrom(request));
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, 200, result.payload);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/patients') {
        const result = await listPatients(authTokenFrom(request));
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, 200, result.payload);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/audit') {
        const result = await listAudit(authTokenFrom(request), Object.fromEntries(url.searchParams.entries()));
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, 200, result.payload);
        return;
      }

      const slotBlockMatch = request.method === 'POST' && url.pathname.match(/^\/api\/slots\/([^/]+)\/block$/);
      if (slotBlockMatch) {
        const body = await readJsonBody(request);
        const slotId = decodeURIComponent(slotBlockMatch[1]);
        const result = await blockSlot(authTokenFrom(request), slotId, body.reason);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/demo/reset') {
        const result = await resetDatabaseForUser(authTokenFrom(request));
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, 200, result.payload);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/pacientes') {
        const result = await listPatientsV1(authTokenFrom(request));
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, 200, result.payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/pacientes') {
        const body = await readJsonBody(request);
        const result = await createPatientV1(authTokenFrom(request), body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const patientMatch = url.pathname.match(/^\/api\/v1\/pacientes\/([^/]+)$/);
      if (patientMatch) {
        const patientId = decodeURIComponent(patientMatch[1]);
        if (request.method === 'GET') {
          const result = await getPatientV1(authTokenFrom(request), patientId);
          if (await sendAuthResult(response, result)) {
            return;
          }
          json(response, result.status, result.payload);
          return;
        }
        if (request.method === 'PATCH') {
          const body = await readJsonBody(request);
          const result = await updatePatientV1(authTokenFrom(request), patientId, body);
          if (await sendAuthResult(response, result)) {
            return;
          }
          json(response, result.status, result.payload);
          return;
        }
      }

      const patientContactsMatch = url.pathname.match(/^\/api\/v1\/pacientes\/([^/]+)\/contactos$/);
      if (patientContactsMatch) {
        const patientId = decodeURIComponent(patientContactsMatch[1]);
        if (request.method === 'GET') {
          const result = await listPatientContactsV1(authTokenFrom(request), patientId);
          if (await sendAuthResult(response, result)) {
            return;
          }
          json(response, result.status, result.payload);
          return;
        }
        if (request.method === 'POST') {
          const body = await readJsonBody(request);
          const result = await createPatientContactV1(authTokenFrom(request), patientId, body);
          if (await sendAuthResult(response, result)) {
            return;
          }
          json(response, result.status, result.payload);
          return;
        }
      }

      const patientContactPatchMatch = url.pathname.match(/^\/api\/v1\/pacientes\/([^/]+)\/contactos\/([^/]+)$/);
      if (patientContactPatchMatch && request.method === 'PATCH') {
        const patientId = decodeURIComponent(patientContactPatchMatch[1]);
        const contactId = decodeURIComponent(patientContactPatchMatch[2]);
        const body = await readJsonBody(request);
        const result = await updatePatientContactV1(authTokenFrom(request), patientId, contactId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const patientPreferencesMatch = url.pathname.match(/^\/api\/v1\/pacientes\/([^/]+)\/preferencias$/);
      if (patientPreferencesMatch && request.method === 'PATCH') {
        const patientId = decodeURIComponent(patientPreferencesMatch[1]);
        const body = await readJsonBody(request);
        const result = await updatePatientPreferencesV1(authTokenFrom(request), patientId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const patientRepresentativesMatch = url.pathname.match(/^\/api\/v1\/pacientes\/([^/]+)\/representantes$/);
      if (patientRepresentativesMatch && request.method === 'POST') {
        const patientId = decodeURIComponent(patientRepresentativesMatch[1]);
        const body = await readJsonBody(request);
        const result = await createPatientRepresentativeV1(authTokenFrom(request), patientId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const patientRepresentativePatchMatch = url.pathname.match(/^\/api\/v1\/pacientes\/([^/]+)\/representantes\/([^/]+)$/);
      if (patientRepresentativePatchMatch && request.method === 'PATCH') {
        const patientId = decodeURIComponent(patientRepresentativePatchMatch[1]);
        const representativeId = decodeURIComponent(patientRepresentativePatchMatch[2]);
        const body = await readJsonBody(request);
        const result = await updatePatientRepresentativeV1(authTokenFrom(request), patientId, representativeId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const patientConsentsMatch = url.pathname.match(/^\/api\/v1\/pacientes\/([^/]+)\/consentimientos$/);
      if (patientConsentsMatch) {
        const patientId = decodeURIComponent(patientConsentsMatch[1]);
        if (request.method === 'GET') {
          const result = await listPatientConsentsV1(authTokenFrom(request), patientId);
          if (await sendAuthResult(response, result)) {
            return;
          }
          json(response, result.status, result.payload);
          return;
        }
        if (request.method === 'POST') {
          const body = await readJsonBody(request);
          const result = await createPatientConsentV1(authTokenFrom(request), patientId, body);
          if (await sendAuthResult(response, result)) {
            return;
          }
          json(response, result.status, result.payload);
          return;
        }
      }

      const patientConsentPatchMatch = url.pathname.match(/^\/api\/v1\/pacientes\/([^/]+)\/consentimientos\/([^/]+)$/);
      if (patientConsentPatchMatch && request.method === 'PATCH') {
        const patientId = decodeURIComponent(patientConsentPatchMatch[1]);
        const consentId = decodeURIComponent(patientConsentPatchMatch[2]);
        const body = await readJsonBody(request);
        const result = await updatePatientConsentV1(authTokenFrom(request), patientId, consentId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/lista-espera') {
        const result = await listWaitlistV1(authTokenFrom(request));
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, 200, result.payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/lista-espera') {
        const body = await readJsonBody(request);
        const result = await createWaitlistEntryV1(authTokenFrom(request), body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const waitlistCloseMatch = url.pathname.match(/^\/api\/v1\/lista-espera\/([^/]+)\/cerrar$/);
      if (waitlistCloseMatch && request.method === 'POST') {
        const waitlistId = decodeURIComponent(waitlistCloseMatch[1]);
        const body = await readJsonBody(request);
        const result = await closeWaitlistEntryV1(authTokenFrom(request), waitlistId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const waitlistOfferMatch = url.pathname.match(/^\/api\/v1\/lista-espera\/([^/]+)\/ofertas$/);
      if (waitlistOfferMatch && request.method === 'POST') {
        const waitlistId = decodeURIComponent(waitlistOfferMatch[1]);
        const body = await readJsonBody(request);
        const result = await createWaitlistOfferV1(authTokenFrom(request), waitlistId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const waitlistOfferResolveMatch = url.pathname.match(/^\/api\/v1\/lista-espera\/ofertas\/([^/]+)\/resolver$/);
      if (waitlistOfferResolveMatch && request.method === 'POST') {
        const offerId = decodeURIComponent(waitlistOfferResolveMatch[1]);
        const body = await readJsonBody(request);
        const result = await resolveWaitlistOfferV1(authTokenFrom(request), offerId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const campaignApproveMatch = url.pathname.match(/^\/api\/v1\/campanas\/([^/]+)\/aprobacion$/);
      if (campaignApproveMatch && request.method === 'POST') {
        const campaignId = decodeURIComponent(campaignApproveMatch[1]);
        const body = await readJsonBody(request);
        const result = await approveCampaignV1(authTokenFrom(request), campaignId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const campaignScheduleMatch = url.pathname.match(/^\/api\/v1\/campanas\/([^/]+)\/programacion$/);
      if (campaignScheduleMatch && request.method === 'POST') {
        const campaignId = decodeURIComponent(campaignScheduleMatch[1]);
        const body = await readJsonBody(request);
        const result = await scheduleCampaignV1(authTokenFrom(request), campaignId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const campaignMetricsMatch = url.pathname.match(/^\/api\/v1\/campanas\/([^/]+)\/metricas$/);
      if (campaignMetricsMatch && request.method === 'GET') {
        const campaignId = decodeURIComponent(campaignMetricsMatch[1]);
        const result = await getCampaignMetricsV1(authTokenFrom(request), campaignId);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const campaignExportMatch = url.pathname.match(/^\/api\/v1\/campanas\/([^/]+)\/exportacion$/);
      if (campaignExportMatch && request.method === 'POST') {
        const campaignId = decodeURIComponent(campaignExportMatch[1]);
        const body = await readJsonBody(request);
        const result = await exportCampaignMetricsV1(authTokenFrom(request), campaignId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/reportes/mensual') {
        const result = await listMonthlyReportsV1(authTokenFrom(request), Object.fromEntries(url.searchParams.entries()));
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/reportes/mensual') {
        const body = await readJsonBody(request);
        const result = await createMonthlyReportV1(authTokenFrom(request), body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/reportes/mensual/exportacion') {
        const body = await readJsonBody(request);
        const result = await exportMonthlyReportV1(authTokenFrom(request), body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/continuidad/backups') {
        const result = await listBackupsV1(authTokenFrom(request));
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/continuidad/backups') {
        const body = await readJsonBody(request);
        const result = await createBackupV1(authTokenFrom(request), body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/continuidad/restores') {
        const body = await readJsonBody(request);
        const result = await restoreBackupV1(authTokenFrom(request), body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const surveyResponseMatch = url.pathname.match(/^\/api\/v1\/encuestas\/([^/]+)\/respuestas$/);
      if (surveyResponseMatch && request.method === 'POST') {
        const surveyId = decodeURIComponent(surveyResponseMatch[1]);
        const body = await readJsonBody(request);
        const result = await recordSurveyResponseV1(authTokenFrom(request), surveyId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/contactabilidad/plantillas') {
        const result = await listContactTemplatesV1(authTokenFrom(request));
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/contactabilidad/plantillas') {
        const body = await readJsonBody(request);
        const result = await createContactTemplateV1(authTokenFrom(request), body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const contactTemplatePatchMatch = url.pathname.match(/^\/api\/v1\/contactabilidad\/plantillas\/([^/]+)$/);
      if (contactTemplatePatchMatch && request.method === 'PATCH') {
        const templateId = decodeURIComponent(contactTemplatePatchMatch[1]);
        const body = await readJsonBody(request);
        const result = await updateContactTemplateV1(authTokenFrom(request), templateId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/contactabilidad/envios') {
        const result = await listContactMessagesV1(authTokenFrom(request));
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/contactabilidad/envios') {
        const body = await readJsonBody(request);
        const result = await sendContactMessageV1(authTokenFrom(request), body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/contactabilidad/webhook') {
        const body = await readJsonBody(request);
        const result = await receiveContactWebhookV1(authTokenFrom(request), body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const contactCaseCloseMatch = url.pathname.match(/^\/api\/v1\/contactabilidad\/casos\/([^/]+)\/cerrar$/);
      if (contactCaseCloseMatch && request.method === 'POST') {
        const caseId = decodeURIComponent(contactCaseCloseMatch[1]);
        const body = await readJsonBody(request);
        const result = await closeContactCaseV1(authTokenFrom(request), caseId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/sidra/eventos') {
        const result = await listSidraEventsV1(authTokenFrom(request), {
          establishment_id: url.searchParams.get('establishment_id'),
          status: url.searchParams.get('status')
        });
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/sidra/eventos') {
        const body = await readJsonBody(request);
        const result = await createSidraEventV1(authTokenFrom(request), body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const sidraProcessMatch = url.pathname.match(/^\/api\/v1\/sidra\/eventos\/([^/]+)\/procesar$/);
      if (sidraProcessMatch && request.method === 'POST') {
        const eventId = decodeURIComponent(sidraProcessMatch[1]);
        const body = await readJsonBody(request);
        const result = await processSidraEventV1(authTokenFrom(request), eventId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const sidraRetryMatch = url.pathname.match(/^\/api\/v1\/sidra\/eventos\/([^/]+)\/reintentar$/);
      if (sidraRetryMatch && request.method === 'POST') {
        const eventId = decodeURIComponent(sidraRetryMatch[1]);
        const body = await readJsonBody(request);
        const result = await retrySidraEventV1(authTokenFrom(request), eventId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const sidraDiscrepancyMatch = url.pathname.match(/^\/api\/v1\/sidra\/eventos\/([^/]+)\/discrepancia\/resolver$/);
      if (sidraDiscrepancyMatch && request.method === 'POST') {
        const eventId = decodeURIComponent(sidraDiscrepancyMatch[1]);
        const body = await readJsonBody(request);
        const result = await resolveSidraDiscrepancyV1(authTokenFrom(request), eventId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/profesionales') {
        const result = await listProfessionalsV1(authTokenFrom(request));
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, 200, result.payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/profesionales') {
        const body = await readJsonBody(request);
        const result = await createProfessionalV1(authTokenFrom(request), body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const professionalPatchMatch = url.pathname.match(/^\/api\/v1\/profesionales\/([^/]+)$/);
      if (professionalPatchMatch && request.method === 'PATCH') {
        const professionalId = decodeURIComponent(professionalPatchMatch[1]);
        const body = await readJsonBody(request);
        const result = await updateProfessionalV1(authTokenFrom(request), professionalId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/prestaciones') {
        const result = await listServicesV1(authTokenFrom(request));
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, 200, result.payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/prestaciones') {
        const body = await readJsonBody(request);
        const result = await createServiceV1(authTokenFrom(request), body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const servicePatchMatch = url.pathname.match(/^\/api\/v1\/prestaciones\/([^/]+)$/);
      if (servicePatchMatch && request.method === 'PATCH') {
        const serviceId = decodeURIComponent(servicePatchMatch[1]);
        const body = await readJsonBody(request);
        const result = await updateServiceV1(authTokenFrom(request), serviceId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/agendas') {
        const result = await listAgendasV1(authTokenFrom(request));
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, 200, result.payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/agendas') {
        const body = await readJsonBody(request);
        const result = await createAgendaV1(authTokenFrom(request), body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const agendaPatchMatch = url.pathname.match(/^\/api\/v1\/agendas\/([^/]+)$/);
      if (agendaPatchMatch && request.method === 'PATCH') {
        const agendaId = decodeURIComponent(agendaPatchMatch[1]);
        const body = await readJsonBody(request);
        const result = await updateAgendaV1(authTokenFrom(request), agendaId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/cupos') {
        const result = await listSlotsV1(authTokenFrom(request));
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, 200, result.payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/cupos') {
        const body = await readJsonBody(request);
        const result = await createSlotV1(authTokenFrom(request), body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const slotPatchMatch = url.pathname.match(/^\/api\/v1\/cupos\/([^/]+)$/);
      if (slotPatchMatch && request.method === 'PATCH') {
        const slotId = decodeURIComponent(slotPatchMatch[1]);
        const body = await readJsonBody(request);
        const result = await updateSlotV1(authTokenFrom(request), slotId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/agendas/disponibilidad') {
        const result = await listAvailabilityV1(authTokenFrom(request), Object.fromEntries(url.searchParams.entries()));
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, 200, result.payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/citas') {
        const body = await readJsonBody(request);
        const result = await createAppointmentV1(authTokenFrom(request), body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const appointmentMatch = url.pathname.match(/^\/api\/v1\/citas\/([^/]+)$/);
      if (appointmentMatch && request.method === 'GET') {
        const appointmentId = decodeURIComponent(appointmentMatch[1]);
        const result = await getAppointmentV1(authTokenFrom(request), appointmentId);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const patientAppointmentsMatch = url.pathname.match(/^\/api\/v1\/pacientes\/([^/]+)\/citas$/);
      if (patientAppointmentsMatch && request.method === 'GET') {
        const patientId = decodeURIComponent(patientAppointmentsMatch[1]);
        const result = await listPatientAppointmentsV1(authTokenFrom(request), patientId);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const appointmentConfirmMatch = url.pathname.match(/^\/api\/v1\/citas\/([^/]+)\/confirmacion$/);
      if (appointmentConfirmMatch && request.method === 'PATCH') {
        const appointmentId = decodeURIComponent(appointmentConfirmMatch[1]);
        const body = await readJsonBody(request);
        const result = await confirmAppointmentV1(authTokenFrom(request), appointmentId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const appointmentRescheduleMatch = url.pathname.match(/^\/api\/v1\/citas\/([^/]+)\/reprogramar$/);
      if (appointmentRescheduleMatch && request.method === 'POST') {
        const appointmentId = decodeURIComponent(appointmentRescheduleMatch[1]);
        const body = await readJsonBody(request);
        const result = await rescheduleAppointmentV1(authTokenFrom(request), appointmentId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      const appointmentCancelMatch = url.pathname.match(/^\/api\/v1\/citas\/([^/]+)\/cancelar$/);
      if (appointmentCancelMatch && request.method === 'POST') {
        const appointmentId = decodeURIComponent(appointmentCancelMatch[1]);
        const body = await readJsonBody(request);
        const result = await cancelAppointmentV1(authTokenFrom(request), appointmentId, body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/agendas/bloqueos') {
        const body = await readJsonBody(request);
        const result = await createAgendaBlockV1(authTokenFrom(request), body);
        if (await sendAuthResult(response, result)) {
          return;
        }
        json(response, result.status, result.payload);
        return;
      }

      if (enableFrontend) {
        await serveFrontend(url.pathname, response);
        return;
      }

      json(response, 404, { error: 'route_not_found', path: url.pathname });
    } catch (error) {
      const status = error.message === 'payload_too_large' ? 413 : 500;
      json(response, status, { error: 'internal_error', message: error.message });
    }
  });
}

export async function startServer(options = {}) {
  const runtime = await loadRuntime();
  await ensureOperationalSeed(runtime);
  const server = createServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port || 4310, process.env.HOST || '0.0.0.0', resolve);
  });
  return server;
}

const args = parseArgs(process.argv.slice(2));
if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  startServer({
    port: args.port,
    serveFrontend: args.serveFrontend
  }).then(() => {
    console.log(`quilicura backend listening on http://127.0.0.1:${args.port}`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
