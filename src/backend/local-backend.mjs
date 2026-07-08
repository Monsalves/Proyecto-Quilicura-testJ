import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadSqliteDatabase, saveSqliteDatabase, sqliteStorageLocation } from './sqlite-store.mjs';

function overrideUrl(envName, fallbackRelative, { directory = false } = {}) {
  const target = process.env[envName];
  if (!target) {
    return new URL(fallbackRelative, import.meta.url);
  }
  const href = pathToFileURL(resolve(target)).href;
  return new URL(directory ? `${href}/` : href);
}

const DATABASE_URL = overrideUrl('QUILICURA_DB_PATH', '../../data/quilicura.sqlite');
const RUNTIME_URL = overrideUrl('QUILICURA_RUNTIME_PATH', '../../config/operational.json');
const BACKUPS_DIR_URL = overrideUrl('QUILICURA_BACKUPS_DIR', '../../data/backups/', { directory: true });

const VIEW_PERMISSIONS = {
  dashboard: 'dashboard.view',
  agenda: 'agenda.read',
  patients: 'patients.read',
  waitlist: 'waitlist.read',
  contact: 'contact.read',
  campaigns: 'campaigns.read',
  sidra: 'sidra.read',
  reports: 'reports.read',
  audit: 'audit.view',
  contract: 'contract.view'
};

const PATIENT_STATUSES = new Set(['activo', 'fallecido', 'fusionado', 'inactivo', 'pendiente_validacion']);
const CONTACT_TYPES = new Set(['telefono', 'correo', 'domicilio', 'otro']);
const CONTACT_CHANNELS = new Set(['telefono', 'sms', 'whatsapp', 'correo', 'domicilio', 'otro']);
const CONSENT_STATUSES = new Set(['vigente', 'revocado']);
const LANGUAGES = new Set(['espanol', 'creole', 'otro']);
const APPOINTMENT_STATUSES = new Set(['agendada', 'confirmada', 'cancelada', 'reprogramada', 'reprogramacion_solicitada']);
const APPOINTMENT_ACTIVE_STATUSES = new Set(['agendada', 'confirmada', 'reprogramacion_solicitada']);
const SLOT_STATUSES = new Set(['disponible', 'reservado', 'bloqueado']);
const AGENDA_ENTITY_STATUSES = new Set(['active', 'inactive']);
const WAITLIST_ENTRY_STATUSES = new Set(['activa', 'oferta_activa', 'resuelta', 'cerrada']);
const WAITLIST_ACTIVE_STATUSES = new Set(['activa', 'oferta_activa']);
const WAITLIST_OFFER_STATUSES = new Set(['pendiente_respuesta', 'aceptada', 'rechazada', 'expirada', 'cancelada']);
const CONTACT_TEMPLATE_STATUSES = new Set(['draft', 'active', 'archived']);
const CONTACT_CASE_STATUSES = new Set(['activa', 'respuesta_recibida', 'rebote', 'no_contactable', 'escalada', 'cerrada']);
const CONTACT_MESSAGE_STATUSES = new Set(['sent', 'delivered', 'responded', 'bounced', 'failed', 'escalated', 'blocked']);
const CONTACT_MESSAGE_RESULTS = new Set(['success', 'bounce', 'failed', 'no_response', 'escalated']);
const CONTACT_CASE_CLOSE_REASONS = new Set(['no_contactable', 'manual_resolution']);
const CONTACT_CHANNELS_SECURE = new Set(['telefono', 'portal', 'domicilio']);
const CONTACT_CHANNELS_INSECURE_FOR_SENSITIVE = new Set(['sms', 'correo', 'whatsapp']);
const CONTACT_CHANNELS_SUPPORTED = new Set(['telefono', 'sms', 'correo', 'whatsapp', 'portal', 'domicilio']);
const CAMPAIGN_STATUSES = new Set(['draft', 'approved', 'scheduled', 'completed']);
const SURVEY_STATUSES = new Set(['active', 'inactive']);
const SIDRA_EVENT_STATUSES = new Set(['queued', 'sent', 'acknowledged', 'rejected', 'retry_pending', 'failed', 'discrepancy']);
const SIDRA_PROCESS_RESULTS = new Set(['acknowledged', 'rejected', 'failed', 'discrepancy']);
const SIDRA_ENTITIES = new Set(['appointment', 'waitlist', 'contact_case', 'patient', 'manual_batch']);
const WAITLIST_RISK_PATTERN = /cronico|cardio|ges/i;
const WEEKDAYS_ES = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab'];

async function readJson(url) {
  return JSON.parse(await readFile(url, 'utf8'));
}

async function writeJson(url, value) {
  await writeFile(url, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function isoNow() {
  return new Date().toISOString();
}

function parseDate(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ageFromBirthDate(value) {
  const parsed = parseDate(value);
  if (!parsed) {
    return null;
  }
  const now = new Date();
  const birth = new Date(parsed);
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - birth.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < birth.getUTCDate())) {
    age -= 1;
  }
  return age;
}

function slotDayLabel(value) {
  const parsed = parseDate(value);
  if (!parsed) {
    return '';
  }
  const date = new Date(parsed);
  return `${WEEKDAYS_ES[date.getUTCDay()]} ${String(date.getUTCDate()).padStart(2, '0')}`;
}

function slotTimeLabel(value) {
  const parsed = parseDate(value);
  if (!parsed) {
    return '';
  }
  const date = new Date(parsed);
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

function normalizeSlotRecord(slot) {
  return {
    ...slot,
    day: slot.day || slotDayLabel(slot.starts_at),
    time: slot.time || slotTimeLabel(slot.starts_at)
  };
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function canonicalRut(value) {
  return String(value || '').replaceAll('.', '').replaceAll('-', '').trim().toUpperCase();
}

function validRut(value) {
  return /^(?:\d{7,8}[\dK]|\d{1,2}\.\d{3}\.\d{3}-[\dK])$/i.test(String(value || '').trim());
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeNullableText(value) {
  const text = normalizeText(value);
  return text ? text : null;
}

function isoMonth(value = isoNow()) {
  return String(value).slice(0, 7);
}

function startsInPeriod(value, period) {
  if (!period) {
    return true;
  }
  return String(value || '').startsWith(period);
}

function validPhone(value) {
  return /^\+56\s?9\s?\d{4}\s?\d{4}$|^\+569\d{8}$/.test(String(value || '').trim());
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'local';
}

function seedUrlFromRuntime(runtime) {
  return new URL(`../../${runtime.storage?.seed || 'data/seed-r03.json'}`, import.meta.url);
}

function verifyPassword(password, serializedHash) {
  const [scheme, saltHex, digestHex] = String(serializedHash || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !digestHex) {
    return false;
  }
  const derived = scryptSync(password, Buffer.from(saltHex, 'hex'), digestHex.length / 2);
  const digest = Buffer.from(digestHex, 'hex');
  return derived.length === digest.length && timingSafeEqual(derived, digest);
}

function sanitizeUser(user) {
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    facility: user.facility,
    establishment_id: user.establishment_id,
    status: user.status
  };
}

function sanitizeRole(role) {
  return role ? {
    id: role.id,
    label: role.label,
    scope_mode: role.scope_mode
  } : null;
}

function sanitizeEstablishment(establishment) {
  return establishment ? {
    id: establishment.id,
    name: establishment.name,
    type: establishment.type
  } : null;
}

function nextSessionId(db) {
  return `SES-${String((db.sessions || []).length + 1).padStart(4, '0')}`;
}

function nextSequenceId(items, prefix, pad = 4) {
  let max = 0;
  for (const item of items || []) {
    const value = Number(String(item.id || '').replace(`${prefix}-`, ''));
    if (Number.isFinite(value) && value > max) {
      max = value;
    }
  }
  return `${prefix}-${String(max + 1).padStart(pad, '0')}`;
}

function sessionTtlSeconds(runtime, user) {
  const fromUser = Number(user?.session_ttl_seconds || 0);
  if (fromUser > 0) {
    return fromUser;
  }
  const fromRuntime = Number(runtime.auth?.session_ttl_seconds || 0);
  return fromRuntime > 0 ? fromRuntime : 2700;
}

function buildSession(db, runtime, user) {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + sessionTtlSeconds(runtime, user) * 1000);
  const token = randomBytes(24).toString('hex');
  return {
    token,
    record: {
      id: nextSessionId(db),
      token_hash: hashToken(token),
      user_id: user.id,
      created_at: createdAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      revoked_at: null,
      revoked_reason: null,
      last_seen_at: createdAt.toISOString()
    }
  };
}

function isSessionExpired(session) {
  return parseDate(session?.expires_at) <= Date.now();
}

function cleanupSessions(db) {
  const floor = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return {
    ...db,
    sessions: (db.sessions || []).filter((session) => {
      if (!session) {
        return false;
      }
      if (session.revoked_at) {
        return parseDate(session.revoked_at) >= floor;
      }
      return parseDate(session.expires_at) >= floor;
    }).slice(0, 150)
  };
}

export async function loadRuntime() {
  return readJson(RUNTIME_URL);
}

export async function loadDatabase() {
  return cleanupSessions(loadSqliteDatabase(DATABASE_URL));
}

export async function saveDatabase(db) {
  if (db.production_data !== false || db.sidra_mode !== 'simulated' || db.safe_mode?.external_writes !== false) {
    throw new Error('unsafe local database state rejected');
  }
  await saveSqliteDatabase(DATABASE_URL, cleanupSessions(db));
}

export function appendAudit(db, entry) {
  const record = {
    at: isoNow(),
    actor: entry.actor || 'system',
    role: entry.role || 'system',
    action: entry.action,
    entity: entry.entity || 'system',
    result: entry.result || 'pass',
    detail: entry.detail,
    origin: entry.origin || 'local_http'
  };
  if (entry.before !== undefined) {
    record.before = entry.before;
  }
  if (entry.after !== undefined) {
    record.after = entry.after;
  }
  return {
    ...db,
    audit: [record, ...(db.audit || [])].slice(0, 300)
  };
}

function permissionCatalog(db) {
  return (db.permissions || []).map((permission) => ({
    id: permission.id,
    label: permission.label,
    module: permission.module
  }));
}

function findUserByUsername(db, username) {
  return (db.users || []).find((user) => user.username === String(username || '').trim().toLowerCase());
}

function findUserById(db, userId) {
  return (db.users || []).find((user) => user.id === userId);
}

function findSessionByToken(db, token) {
  const tokenHash = hashToken(token);
  return (db.sessions || []).find((session) => session.token_hash === tokenHash);
}

function findRoleById(db, roleId) {
  return (db.roles || []).find((role) => role.id === roleId);
}

function findEstablishmentById(db, establishmentId) {
  return (db.establishments || []).find((item) => item.id === establishmentId);
}

function findPatientById(db, patientId) {
  return (db.patients || []).find((item) => item.id === patientId);
}

function findSlotById(db, slotId) {
  return (db.slots || []).find((slot) => slot.id === slotId);
}

function findProfessionalById(db, professionalId) {
  return (db.professionals || []).find((item) => item.id === professionalId);
}

function findServiceById(db, serviceId) {
  return (db.services || []).find((item) => item.id === serviceId);
}

function findAgendaById(db, agendaId) {
  return (db.agendas || []).find((item) => item.id === agendaId);
}

function findAppointmentById(db, appointmentId) {
  return (db.appointments || []).find((item) => item.id === appointmentId);
}

function findWaitlistEntryById(db, waitlistId) {
  return (db.waitlist || []).find((item) => item.id === waitlistId);
}

function findWaitlistOfferById(db, offerId) {
  return (db.waitlist_offers || []).find((item) => item.id === offerId);
}

function findContactTemplateById(db, templateId) {
  return (db.contact_templates || []).find((item) => item.id === templateId);
}

function findCampaignById(db, campaignId) {
  return (db.campaigns || []).find((item) => item.id === campaignId);
}

function findSurveyById(db, surveyId) {
  return (db.surveys || []).find((item) => item.id === surveyId);
}

function findContactCaseById(db, caseId) {
  return (db.contact_cases || []).find((item) => item.id === caseId);
}

function findContactMessageById(db, messageId) {
  return (db.contact_messages || []).find((item) => item.id === messageId);
}

function findSidraEventById(db, eventId) {
  return (db.sidra || []).find((item) => item.id === eventId);
}

function sidraAttemptsForEvent(db, eventId) {
  return (db.sidra_attempts || []).filter((item) => item.sidra_event_id === eventId);
}

function messagesForContactCase(db, caseId) {
  return (db.contact_messages || []).filter((item) => item.case_id === caseId);
}

function activeContactCaseFor(db, patientId, purpose) {
  return (db.contact_cases || []).find((item) =>
    item.patient_id === patientId &&
    item.purpose === purpose &&
    ['activa', 'rebote', 'escalada'].includes(item.status)
  ) || null;
}

function campaignRecipientsFor(db, campaignId) {
  return (db.campaign_recipients || []).filter((item) => item.campaign_id === campaignId);
}

function surveyResponsesFor(db, campaignId) {
  return (db.survey_responses || []).filter((item) => item.campaign_id === campaignId);
}

function appointmentHistoryFor(db, appointmentId) {
  return (db.appointment_history || []).filter((item) => item.appointment_id === appointmentId);
}

function waitlistEventsFor(db, waitlistId) {
  return (db.waitlist_events || []).filter((item) => item.waitlist_id === waitlistId);
}

function agendaBlocksForSlot(db, slotId) {
  return (db.agenda_blocks || []).filter((item) => (item.slot_ids || []).includes(slotId));
}

function slotStartMillis(slot) {
  return parseDate(slot?.starts_at);
}

function slotIsPast(slot) {
  const start = slotStartMillis(slot);
  return Boolean(start) && start <= Date.now();
}

function slotScopeOrAgendaScope(slot = {}, agenda = {}) {
  return slot.establishment_id || agenda.establishment_id || null;
}

function appointmentAllowsRelease(runtime, slot) {
  const cutoffHours = Number(runtime.agenda_rules?.cancel_release_cutoff_hours || 24);
  const cutoffMillis = cutoffHours * 60 * 60 * 1000;
  return slotStartMillis(slot) - Date.now() >= cutoffMillis;
}

function waitlistOfferTtlMinutes(runtime) {
  const ttl = Number(runtime.waitlist?.offer_ttl_minutes || 90);
  return ttl > 0 ? ttl : 90;
}

function sidraRetryLimit(runtime) {
  const retries = Number(runtime.sidra?.max_retries || 3);
  return retries > 0 ? retries : 3;
}

function sidraRetryDelayMinutes(runtime) {
  const minutes = Number(runtime.sidra?.retry_delay_minutes || 15);
  return minutes > 0 ? minutes : 15;
}

function sidraTransitionAllowed(status, target) {
  if (target === 'process') {
    return ['queued', 'retry_pending'].includes(status);
  }
  if (target === 'retry') {
    return ['retry_pending', 'failed', 'rejected'].includes(status);
  }
  if (target === 'resolve_discrepancy') {
    return status === 'discrepancy';
  }
  return false;
}

function chronicRisk(value) {
  return WAITLIST_RISK_PATTERN.test(String(value || ''));
}

function waitlistPrioritySnapshot(entry, patient, slot = null) {
  const requestedAt = parseDate(entry.requested_at || entry.created_at || isoNow());
  const sameEstablishment = slot ? entry.establishment_id === slot.establishment_id : true;
  return {
    priority_bucket: chronicRisk(entry.priority_reason || patient?.risk) ? 'riesgo_cronico' : 'estandar',
    requested_at: requestedAt,
    establishment_match: sameEstablishment
  };
}

function campaignMetricsFor(db, campaign) {
  const recipients = campaignRecipientsFor(db, campaign.id);
  const responses = surveyResponsesFor(db, campaign.id);
  const scores = responses.map((item) => Number(item.score)).filter((value) => Number.isFinite(value));
  const averageScore = scores.length ? Number((scores.reduce((sum, value) => sum + value, 0) / scores.length).toFixed(2)) : null;
  return {
    audience_total: recipients.length,
    delivered: recipients.filter((item) => item.status === 'sent').length,
    responded: responses.length,
    average_score: averageScore,
    bounced: recipients.filter((item) => item.status === 'bounced').length,
    failed: recipients.filter((item) => item.status === 'failed').length
  };
}

function monthlyReportView(report) {
  return {
    ...report,
    export_identifiable: false
  };
}

function reportFiltersSummary(filters = {}) {
  return {
    period: filters.period || isoMonth(),
    establishment_id: filters.establishment_id || null,
    service_id: filters.service_id || null,
    channel: filters.channel || null
  };
}

function monthlyReportMatches(report, access, filters = {}) {
  if (!report) {
    return false;
  }
  if (report.establishment_ids?.some((item) => !withinScope(access, item))) {
    return false;
  }
  if (filters.period && report.period !== filters.period) {
    return false;
  }
  if (filters.establishment_id && !(report.establishment_ids || []).includes(filters.establishment_id)) {
    return false;
  }
  if (filters.service_id && report.filters?.service_id !== filters.service_id) {
    return false;
  }
  if (filters.channel && report.filters?.channel !== filters.channel) {
    return false;
  }
  return true;
}

function auditMatchesFilters(entry, filters = {}) {
  if (!entry) {
    return false;
  }
  if (filters.actor && entry.actor !== filters.actor) {
    return false;
  }
  if (filters.entity && !String(entry.entity || '').includes(filters.entity)) {
    return false;
  }
  if (filters.result && entry.result !== filters.result) {
    return false;
  }
  if (filters.action && !String(entry.action || '').includes(filters.action)) {
    return false;
  }
  return true;
}

function reportableServiceIdForAppointment(appointment, slot = null) {
  return appointment?.service_id || slot?.service_id || null;
}

function aggregateCount(items, key) {
  return Object.entries(
    (items || []).reduce((acc, item) => {
      const bucket = item?.[key] || 'sin_dato';
      acc[bucket] = (acc[bucket] || 0) + 1;
      return acc;
    }, {})
  ).map(([id, total]) => ({ id, total })).sort((left, right) => right.total - left.total || String(left.id).localeCompare(String(right.id)));
}

function buildMonthlyReport(runtime, db, access, inputFilters = {}) {
  const filters = reportFiltersSummary(inputFilters);
  const visiblePatients = filterEntities(db.patients, access, 'patients.read');
  const visibleAppointments = filterEntities(db.appointments, access, 'agenda.read');
  const visibleWaitlist = filterEntities(db.waitlist, access, 'waitlist.read');
  const visibleCampaigns = filterEntities(db.campaigns, access, 'campaigns.read');
  const visibleCampaignRecipients = filterEntities(db.campaign_recipients, access, 'campaigns.read');
  const visibleSurveyResponses = filterEntities(db.survey_responses, access, 'campaigns.read');
  const visibleContactMessages = filterEntities(db.contact_messages, access, 'contact.read');
  const visibleSidra = filterEntities(db.sidra, access, 'sidra.read');

  const appointments = visibleAppointments
    .filter((item) => startsInPeriod(item.created_at || item.updated_at, filters.period))
    .filter((item) => !filters.establishment_id || item.establishment_id === filters.establishment_id)
    .filter((item) => {
      if (!filters.service_id) {
        return true;
      }
      const slot = findSlotById(db, item.slotId);
      return reportableServiceIdForAppointment(item, slot) === filters.service_id;
    });

  const waitlistEntries = visibleWaitlist
    .filter((item) => startsInPeriod(item.created_at || item.requested_at, filters.period))
    .filter((item) => !filters.establishment_id || item.establishment_id === filters.establishment_id)
    .filter((item) => !filters.service_id || item.service_id === filters.service_id);

  const contactMessages = visibleContactMessages
    .filter((item) => startsInPeriod(item.created_at, filters.period))
    .filter((item) => !filters.establishment_id || item.establishment_id === filters.establishment_id)
    .filter((item) => !filters.channel || item.channel === filters.channel);

  const sidraEvents = visibleSidra
    .filter((item) => startsInPeriod(item.created_at, filters.period))
    .filter((item) => !filters.establishment_id || item.establishment_id === filters.establishment_id);

  const campaigns = visibleCampaigns
    .filter((item) => startsInPeriod(item.created_at || item.updated_at, filters.period))
    .filter((item) => !filters.establishment_id || item.establishment_id === filters.establishment_id)
    .filter((item) => !filters.channel || item.channel === filters.channel);

  const campaignIds = new Set(campaigns.map((item) => item.id));
  const campaignRecipients = visibleCampaignRecipients
    .filter((item) => campaignIds.has(item.campaign_id))
    .filter((item) => startsInPeriod(item.created_at, filters.period));
  const surveyResponses = visibleSurveyResponses
    .filter((item) => campaignIds.has(item.campaign_id))
    .filter((item) => startsInPeriod(item.created_at, filters.period));

  const auditRows = access.permissionsSet.has('audit.view')
    ? (db.audit || []).filter((item) => startsInPeriod(item.at, filters.period)).slice(0, 200)
    : [];

  const establishmentIds = [...new Set([
    ...appointments.map((item) => item.establishment_id),
    ...waitlistEntries.map((item) => item.establishment_id),
    ...contactMessages.map((item) => item.establishment_id),
    ...sidraEvents.map((item) => item.establishment_id),
    ...campaigns.map((item) => item.establishment_id)
  ].filter(Boolean))];

  return {
    id: nextSequenceId(db.monthly_reports || [], 'RPT'),
    period: filters.period,
    generated_at: isoNow(),
    generated_by: access.role.id,
    filters,
    establishment_ids: establishmentIds,
    privacy: {
      identifiable_export: false,
      reidentification_block: true
    },
    totals: {
      patients_visible: visiblePatients.filter((item) => !filters.establishment_id || item.establishment_id === filters.establishment_id).length,
      appointments_created: appointments.length,
      appointments_cancelled: appointments.filter((item) => item.status === 'cancelada').length,
      appointments_rescheduled: appointments.filter((item) => ['reprogramada', 'reprogramacion_solicitada'].includes(item.status)).length,
      waitlist_entries: waitlistEntries.length,
      waitlist_high_priority: waitlistEntries.filter((item) => chronicRisk(item.priority_reason)).length,
      campaigns_scheduled: campaigns.filter((item) => item.status === 'scheduled').length,
      campaign_delivered: campaignRecipients.filter((item) => item.status === 'sent').length,
      survey_responses: surveyResponses.length,
      contact_attempts: contactMessages.length,
      contact_bounced: contactMessages.filter((item) => item.status === 'bounced').length,
      sidra_pending: sidraEvents.filter((item) => ['queued', 'retry_pending', 'discrepancy'].includes(item.status)).length,
      sidra_failed: sidraEvents.filter((item) => ['failed', 'rejected'].includes(item.status)).length,
      audit_entries: auditRows.length
    },
    breakdowns: {
      establishments: aggregateCount([
        ...appointments.map((item) => ({ establishment_id: item.establishment_id })),
        ...waitlistEntries.map((item) => ({ establishment_id: item.establishment_id })),
        ...contactMessages.map((item) => ({ establishment_id: item.establishment_id }))
      ], 'establishment_id').map((item) => ({
        ...item,
        name: findEstablishmentById(db, item.id)?.name || item.id
      })),
      services: aggregateCount(appointments.map((item) => {
        const slot = findSlotById(db, item.slotId);
        return { service_id: reportableServiceIdForAppointment(item, slot) };
      }), 'service_id').map((item) => ({
        ...item,
        name: findServiceById(db, item.id)?.name || item.id
      })),
      channels: aggregateCount([
        ...appointments.map((item) => ({ channel: item.channel || 'sin_dato' })),
        ...contactMessages.map((item) => ({ channel: item.channel || 'sin_dato' })),
        ...campaigns.map((item) => ({ channel: item.channel || 'sin_dato' }))
      ], 'channel'),
      sidra_statuses: aggregateCount(sidraEvents, 'status')
    }
  };
}

async function ensureBackupsDir() {
  await mkdir(BACKUPS_DIR_URL, { recursive: true });
}

async function listBackupFiles() {
  await ensureBackupsDir();
  const files = await readdir(BACKUPS_DIR_URL);
  return files.filter((item) => item.endsWith('.json')).sort().reverse();
}

function waitlistSort(runtime, db, entries, slot = null) {
  return [...entries].sort((left, right) => {
    const leftPatient = findPatientById(db, left.patientId);
    const rightPatient = findPatientById(db, right.patientId);
    const leftPriority = waitlistPrioritySnapshot(left, leftPatient, slot);
    const rightPriority = waitlistPrioritySnapshot(right, rightPatient, slot);
    if (leftPriority.priority_bucket !== rightPriority.priority_bucket) {
      return leftPriority.priority_bucket === 'riesgo_cronico' ? -1 : 1;
    }
    if (leftPriority.requested_at !== rightPriority.requested_at) {
      return leftPriority.requested_at - rightPriority.requested_at;
    }
    if (leftPriority.establishment_match !== rightPriority.establishment_match) {
      return leftPriority.establishment_match ? -1 : 1;
    }
    return String(left.id).localeCompare(String(right.id));
  });
}

function activeWaitlistOfferFor(db, waitlistId) {
  return (db.waitlist_offers || []).find((item) =>
    item.waitlist_id === waitlistId && item.status === 'pendiente_respuesta'
  );
}

function roleDefinition(db, user) {
  return findRoleById(db, user?.role) || {
    id: user?.role || 'unknown',
    label: user?.role || 'Sin rol',
    scope_mode: 'assigned_establishments',
    permissions: []
  };
}

function allowedEstablishmentIds(db, user, role) {
  if (role.scope_mode === 'all_establishments') {
    return (db.establishments || []).map((item) => item.id);
  }
  return [...new Set([
    user?.establishment_id,
    ...((user?.establishment_ids || []).filter(Boolean))
  ].filter(Boolean))];
}

function buildAccessContext(runtime, db, user) {
  const role = roleDefinition(db, user);
  const permissions = [...new Set(role.permissions || [])].sort();
  const allowedIds = allowedEstablishmentIds(db, user, role);
  const allowedEstablishments = (db.establishments || []).filter((item) => allowedIds.includes(item.id));
  return {
    runtime,
    role,
    permissions,
    permissionsSet: new Set(permissions),
    scopeMode: role.scope_mode,
    allowedEstablishmentIds: allowedIds,
    allowedEstablishments,
    viewAccess: Object.fromEntries(
      Object.entries(VIEW_PERMISSIONS).map(([view, permission]) => [view, permissions.includes(permission)])
    )
  };
}

function withinScope(access, establishmentId) {
  if (!establishmentId) {
    return true;
  }
  if (access.scopeMode === 'all_establishments') {
    return true;
  }
  return access.allowedEstablishmentIds.includes(establishmentId);
}

function filterEntities(items, access, permission, key = 'establishment_id') {
  if (!access.permissionsSet.has(permission)) {
    return [];
  }
  return (items || []).filter((item) => withinScope(access, item?.[key]));
}

function patientDisplayName(patient) {
  return patient?.social_name || patient?.legal_name || patient?.name || 'Paciente sin nombre';
}

function contactsForPatient(db, patientId) {
  return (db.patient_contacts || []).filter((item) => item.patient_id === patientId);
}

function representativesForPatient(db, patientId) {
  return (db.representatives || []).filter((item) => item.patient_id === patientId);
}

function preferencesForPatient(db, patientId) {
  return (db.contact_preferences || []).find((item) => item.patient_id === patientId) || null;
}

function consentsForPatient(db, patientId) {
  return (db.consents || []).filter((item) => item.patient_id === patientId);
}

function contactView(contact) {
  return {
    id: contact.id,
    type: contact.type,
    channel: contact.channel,
    label: contact.label,
    value: contact.value,
    verified: Boolean(contact.verified),
    active: Boolean(contact.active),
    excluded_from_non_urgent: Boolean(contact.excluded_from_non_urgent),
    source: contact.source,
    updated_at: contact.updated_at
  };
}

function representativeView(representative) {
  return {
    id: representative.id,
    legal_name: representative.legal_name,
    relation: representative.relation,
    phone: representative.phone,
    verified: Boolean(representative.verified),
    status: representative.status,
    notes: representative.notes,
    updated_at: representative.updated_at
  };
}

function preferenceView(preference) {
  return preference ? {
    patient_id: preference.patient_id,
    preferred_channel: preference.preferred_channel,
    language: preference.language,
    allow_non_urgent: Boolean(preference.allow_non_urgent),
    excluded_contact_ids: preference.excluded_contact_ids || [],
    notes: preference.notes,
    updated_at: preference.updated_at
  } : {
    patient_id: null,
    preferred_channel: null,
    language: 'espanol',
    allow_non_urgent: true,
    excluded_contact_ids: [],
    notes: ''
  };
}

function consentView(consent) {
  return {
    id: consent.id,
    purpose: consent.purpose,
    channel_scope: consent.channel_scope || [],
    status: consent.status,
    granted: Boolean(consent.granted),
    granted_at: consent.granted_at,
    revoked_at: consent.revoked_at,
    source: consent.source,
    notes: consent.notes,
    updated_at: consent.updated_at
  };
}

function patientView(db, items, access) {
  return items.map((patient) => {
    const contacts = contactsForPatient(db, patient.id).map(contactView);
    const representatives = representativesForPatient(db, patient.id).map(representativeView);
    const preferences = preferenceView(preferencesForPatient(db, patient.id));
    const consents = consentsForPatient(db, patient.id).map(consentView);
    return {
      ...patient,
      display_name: patientDisplayName(patient),
      age: ageFromBirthDate(patient.birth_date),
      establishment_name: findEstablishmentById(db, patient.establishment_id)?.name || patient.establishment_id,
      contacts,
      representatives,
      preferences,
      consents,
      allowed_actions: {
        manage: access.permissionsSet.has('patients.write') && withinScope(access, patient.establishment_id),
        close: access.permissionsSet.has('patients.write') && withinScope(access, patient.establishment_id) && patient.status === 'activo'
      }
    };
  });
}

function professionalView(db, items) {
  return items.map((professional) => ({
    ...professional,
    establishment_name: findEstablishmentById(db, professional.establishment_id)?.name || professional.establishment_id
  }));
}

function serviceView(db, items) {
  return items.map((service) => ({
    ...service,
    establishment_name: findEstablishmentById(db, service.establishment_id)?.name || service.establishment_id
  }));
}

function agendaView(db, items) {
  return items.map((agenda) => ({
    ...agenda,
    establishment_name: findEstablishmentById(db, agenda.establishment_id)?.name || agenda.establishment_id,
    professional_name: findProfessionalById(db, agenda.professional_id)?.name || agenda.professional_id,
    service_name: findServiceById(db, agenda.service_id)?.name || agenda.service_id
  }));
}

function slotView(db, items, access) {
  return items.map((rawSlot) => {
    const slot = normalizeSlotRecord(rawSlot);
    const agenda = findAgendaById(db, slot.agenda_id);
    return {
      ...slot,
      establishment_name: findEstablishmentById(db, slot.establishment_id)?.name || slot.establishment_id,
      agenda_name: agenda?.name || slot.agenda_id || null,
      professional_name: findProfessionalById(db, slot.professional_id)?.name || slot.professional || slot.professional_id || null,
      service_name: findServiceById(db, slot.service_id)?.name || slot.service || slot.service_id || null,
      blocked_by_rules: slot.status !== 'disponible' || slotIsPast(slot),
      active_block_count: agendaBlocksForSlot(db, slot.id).length,
      allowed_actions: {
        block: access.permissionsSet.has('agenda.block') && withinScope(access, slot.establishment_id) && slot.status === 'disponible',
        book: access.permissionsSet.has('agenda.write') && withinScope(access, slot.establishment_id) && slot.status === 'disponible' && !slotIsPast(slot)
      }
    };
  });
}

function appointmentView(db, items, access) {
  return items.map((appointment) => {
    const patient = findPatientById(db, appointment.patientId);
    const slot = db.slots.find((item) => item.id === appointment.slotId);
    const establishment = findEstablishmentById(db, appointment.establishment_id);
    const service = findServiceById(db, appointment.service_id || slot?.service_id);
    const professional = findProfessionalById(db, appointment.professional_id || slot?.professional_id);
    const history = appointmentHistoryFor(db, appointment.id);
    return {
      ...appointment,
      patient_name: patientDisplayName(patient),
      slot_label: slot ? `${normalizeSlotRecord(slot).day} ${normalizeSlotRecord(slot).time} · ${service?.name || slot.service || slot.service_id || 'Prestacion'}` : 'Slot no encontrado',
      establishment_name: establishment?.name || appointment.establishment_id,
      service_name: service?.name || slot?.service || appointment.service_id || null,
      professional_name: professional?.name || slot?.professional || appointment.professional_id || null,
      starts_at: appointment.starts_at || slot?.starts_at || null,
      history,
      allowed_actions: {
        confirm: access.permissionsSet.has('agenda.write') && withinScope(access, appointment.establishment_id) && appointment.status === 'agendada',
        cancel: access.permissionsSet.has('agenda.write') && withinScope(access, appointment.establishment_id) && APPOINTMENT_ACTIVE_STATUSES.has(appointment.status),
        reprogram: access.permissionsSet.has('agenda.write') && withinScope(access, appointment.establishment_id) && APPOINTMENT_ACTIVE_STATUSES.has(appointment.status)
      }
    };
  });
}

function waitlistOfferView(db, offer) {
  if (!offer) {
    return null;
  }
  const slot = findSlotById(db, offer.slot_id);
  const service = findServiceById(db, offer.service_id || slot?.service_id);
  return {
    ...offer,
    slot_label: slot ? `${normalizeSlotRecord(slot).day} ${normalizeSlotRecord(slot).time}` : offer.slot_id,
    service_name: service?.name || offer.service_id || null
  };
}

function waitlistView(db, items, access, runtime) {
  const ordered = waitlistSort(runtime, db, items);
  return ordered.map((entry, index) => {
    const patient = findPatientById(db, entry.patientId);
    const establishment = findEstablishmentById(db, entry.establishment_id);
    const service = findServiceById(db, entry.service_id);
    const priority = waitlistPrioritySnapshot(entry, patient);
    const activeOffer = activeWaitlistOfferFor(db, entry.id);
    return {
      ...entry,
      service: service?.name || entry.service || entry.service_id,
      patient_name: patientDisplayName(patient),
      establishment_name: establishment?.name || entry.establishment_id,
      priority: priority.priority_bucket,
      priority_rule: entry.priority_rule || runtime.waitlist?.priority_rule_id || 'RL-01',
      priority_reason: entry.priority_reason || patient?.risk || 'Regla local visible',
      priority_rank: index + 1,
      requested_days: Math.max(0, Math.floor((Date.now() - parseDate(entry.requested_at || entry.created_at || isoNow())) / (24 * 60 * 60 * 1000))),
      active_offer: waitlistOfferView(db, activeOffer),
      events: waitlistEventsFor(db, entry.id).slice(0, 8),
      allowed_actions: {
        offer: access.permissionsSet.has('waitlist.write') && withinScope(access, entry.establishment_id) && entry.status === 'activa',
        close: access.permissionsSet.has('waitlist.write') && withinScope(access, entry.establishment_id) && WAITLIST_ACTIVE_STATUSES.has(entry.status),
        resolve_offer: access.permissionsSet.has('waitlist.write') && Boolean(activeOffer) && withinScope(access, entry.establishment_id)
      }
    };
  });
}

function campaignView(db, items, access) {
  return items.map((campaign) => ({
    ...campaign,
    establishment_name: findEstablishmentById(db, campaign.establishment_id)?.name || campaign.establishment_id,
    metrics: campaignMetricsFor(db, campaign),
    allowed_actions: {
      approve: access.permissionsSet.has('campaigns.manage') && withinScope(access, campaign.establishment_id) && campaign.approval_status !== 'approved',
      schedule: access.permissionsSet.has('campaigns.manage') && withinScope(access, campaign.establishment_id) && campaign.approval_status === 'approved' && campaign.status !== 'scheduled',
      export: access.permissionsSet.has('campaigns.export') && withinScope(access, campaign.establishment_id)
    }
  }));
}

function surveyView(db, items) {
  return items.map((survey) => {
    const responses = (db.survey_responses || []).filter((item) => item.survey_id === survey.id);
    const scores = responses.map((item) => Number(item.score)).filter((value) => Number.isFinite(value));
    return {
      ...survey,
      question_count: Array.isArray(survey.questions) ? survey.questions.length : 0,
      response_count: responses.length,
      average_score: scores.length ? Number((scores.reduce((sum, value) => sum + value, 0) / scores.length).toFixed(2)) : null
    };
  });
}

function contactTemplateView(template) {
  return {
    ...template,
    allowed_actions: {
      activate: template.status !== 'active',
      archive: template.status !== 'archived'
    }
  };
}

function contactMessageView(db, message) {
  const patient = findPatientById(db, message.patient_id);
  const contact = (db.patient_contacts || []).find((item) => item.id === message.contact_id);
  const template = findContactTemplateById(db, message.template_id);
  return {
    ...message,
    patient_name: patientDisplayName(patient),
    contact_label: contact?.label || message.channel,
    template_code: template?.code || null
  };
}

function contactCaseView(db, items, access) {
  return items.map((contactCase) => {
    const patient = findPatientById(db, contactCase.patient_id);
    const attempts = messagesForContactCase(db, contactCase.id);
    const channels = [...new Set(attempts.map((item) => item.channel))];
    return {
      ...contactCase,
      patient_name: patientDisplayName(patient),
      establishment_name: findEstablishmentById(db, contactCase.establishment_id)?.name || contactCase.establishment_id,
      attempts,
      attempt_count: attempts.length,
      channel_count: channels.length,
      channels,
      allowed_actions: {
        close_no_contact: access.permissionsSet.has('contact.write') && withinScope(access, contactCase.establishment_id) && attempts.length >= 3 && channels.length >= 2 && ['activa', 'rebote', 'escalada'].includes(contactCase.status),
        send: access.permissionsSet.has('contact.write') && withinScope(access, contactCase.establishment_id) && ['activa', 'rebote', 'escalada'].includes(contactCase.status)
      }
    };
  });
}

function sidraView(db, items, access, runtime) {
  return items.map((event) => sidraEventView(db, event, access, runtime));
}

function summarizeVisible(access, visible) {
  return {
    patients: visible.patients.length,
    active_patients: visible.patients.filter((item) => item.status === 'activo').length,
    active_appointments: visible.appointments.filter((item) => APPOINTMENT_ACTIVE_STATUSES.has(item.status)).length,
    available_slots: visible.slots.filter((item) => item.status === 'disponible').length,
    high_priority_waitlist: visible.waitlist.filter((item) => item.priority === 'riesgo_cronico').length,
    sidra_pending: visible.sidra.filter((item) => ['queued', 'retry_pending', 'discrepancy'].includes(item.status)).length,
    active_contact_cases: visible.contact_cases.filter((item) => ['activa', 'rebote', 'escalada'].includes(item.status)).length,
    sent_contact_messages: visible.contact_messages.filter((item) => item.status !== 'blocked').length,
    managed_patients: visible.patients.filter((item) => item.allowed_actions?.manage).length,
    managed_appointments: visible.appointments.filter((item) => item.allowed_actions?.reprogram || item.allowed_actions?.cancel).length,
    active_sessions: access.permissionsSet.has('session.manage') ? (visible.sessions || []).filter((session) => !session.revoked_at && !isSessionExpired(session)).length : 0,
    audit_entries: visible.audit.length,
    generated_reports: visible.monthly_reports.length,
    continuity_backups: visible.backups.length
  };
}

function rbacPayload(db, access) {
  return {
    role: sanitizeRole(access.role),
    permissions: access.permissions,
    permissions_catalog: permissionCatalog(db),
    scope_mode: access.scopeMode,
    allowed_establishments: access.allowedEstablishments.map(sanitizeEstablishment),
    view_access: access.viewAccess,
    action_access: {
      agenda_block: access.permissionsSet.has('agenda.block'),
      agenda_write: access.permissionsSet.has('agenda.write'),
      patient_write: access.permissionsSet.has('patients.write'),
      waitlist_write: access.permissionsSet.has('waitlist.write'),
      contact_write: access.permissionsSet.has('contact.write'),
      template_manage: access.permissionsSet.has('template.manage'),
      campaign_manage: access.permissionsSet.has('campaigns.manage'),
      campaign_export: access.permissionsSet.has('campaigns.export'),
      sidra_manage: access.permissionsSet.has('sidra.manage'),
      reports_export: access.permissionsSet.has('reports.export'),
      backup_manage: access.permissionsSet.has('backup.manage')
    }
  };
}

export function composeBootstrap(runtime, db, user, session) {
  const access = buildAccessContext(runtime, db, user);
  const visiblePatients = patientView(db, filterEntities(db.patients, access, 'patients.read'), access);
  const visibleProfessionals = professionalView(db, filterEntities(db.professionals, access, 'agenda.read'));
  const visibleServices = serviceView(db, filterEntities(db.services, access, 'agenda.read'));
  const visibleAgendas = agendaView(db, filterEntities(db.agendas, access, 'agenda.read'));
  const visibleSlots = slotView(db, filterEntities(db.slots, access, 'agenda.read'), access);
  const visibleAppointments = appointmentView(db, filterEntities(db.appointments, access, 'agenda.read'), access);
  const visibleWaitlist = waitlistView(db, filterEntities(db.waitlist, access, 'waitlist.read'), access, runtime);
  const visibleContactTemplates = (access.permissionsSet.has('contact.read') || access.permissionsSet.has('template.manage'))
    ? (db.contact_templates || []).map(contactTemplateView)
    : [];
  const visibleContactCases = contactCaseView(db, filterEntities(db.contact_cases, access, 'contact.read'), access);
  const visibleContactMessages = access.permissionsSet.has('contact.read')
    ? filterEntities(db.contact_messages, access, 'contact.read').map((message) => contactMessageView(db, message))
    : [];
  const visibleCampaigns = campaignView(db, filterEntities(db.campaigns, access, 'campaigns.read'), access);
  const visibleSurveys = surveyView(db, filterEntities(db.surveys, access, 'campaigns.read'));
  const visibleSidra = sidraView(db, filterEntities(db.sidra, access, 'sidra.read'), access, runtime);
  const visibleAudit = access.permissionsSet.has('audit.view') ? (db.audit || []).slice(0, 80) : [];
  const visibleReports = access.permissionsSet.has('reports.read')
    ? (db.monthly_reports || []).filter((item) => monthlyReportMatches(item, access)).map(monthlyReportView).slice(0, 24)
    : [];
  const visibleBackups = access.permissionsSet.has('backup.manage')
    ? (db.backups_catalog || []).slice(0, 24)
    : [];
  const visible = {
    patients: visiblePatients,
    professionals: visibleProfessionals,
    services: visibleServices,
    agendas: visibleAgendas,
    slots: visibleSlots,
    appointments: visibleAppointments,
    waitlist: visibleWaitlist,
    contact_templates: visibleContactTemplates,
    contact_cases: visibleContactCases,
    contact_messages: visibleContactMessages,
    campaigns: visibleCampaigns,
    surveys: visibleSurveys,
    sidra: visibleSidra,
    audit: visibleAudit,
    monthly_reports: visibleReports,
    backups: visibleBackups,
    sessions: db.sessions || []
  };
  return {
    runtime,
    current_user: sanitizeUser(user),
    current_session: session ? {
      id: session.id,
      created_at: session.created_at,
      expires_at: session.expires_at
    } : null,
    rbac: rbacPayload(db, access),
    summary: summarizeVisible(access, visible),
    establishments: access.allowedEstablishments.map(sanitizeEstablishment),
    patients: visiblePatients,
    professionals: visibleProfessionals,
    services: visibleServices,
    agendas: visibleAgendas,
    slots: visibleSlots,
    appointments: visibleAppointments,
    waitlist: visibleWaitlist,
    contact_templates: visibleContactTemplates,
    contact_cases: visibleContactCases,
    contact_messages: visibleContactMessages,
    campaigns: visibleCampaigns,
    surveys: visibleSurveys,
    sidra: visibleSidra,
    audit: visibleAudit,
    monthly_reports: visibleReports,
    backups: visibleBackups,
    roles: (db.roles || []).map((role) => ({
      id: role.id,
      label: role.label,
      scope_mode: role.scope_mode,
      permission_count: (role.permissions || []).length
    })),
    permissions_catalog: permissionCatalog(db),
    app_contract: db.app_contract,
    legacy_debt: db.legacy_debt
  };
}

async function denyAuth(db, payload) {
  await saveDatabase(db);
  return {
    ok: false,
    ...payload
  };
}

async function denyPermission(auth, {
  permission,
  entity,
  message,
  establishmentId = null,
  deniedKind = 'permission',
  detail
}) {
  const action = deniedKind === 'scope' ? 'rbac.scope.denied' : 'rbac.permission.denied';
  const db = appendAudit(auth.db, {
    actor: auth.user.username,
    role: auth.user.role,
    action,
    entity,
    result: 'denied',
    detail
  });
  await saveDatabase(db);
  return {
    ok: false,
    status: 403,
    error: 'permission_denied',
    message,
    permission,
    role: auth.user.role,
    scope: auth.access.scopeMode,
    establishment_id: establishmentId,
    denied_kind: deniedKind
  };
}

function validationError(message, field, extra = {}) {
  return {
    ok: false,
    status: 422,
    error: 'validation_error',
    field,
    message,
    ...extra
  };
}

function conflictError(message, field, extra = {}) {
  return {
    ok: false,
    status: 409,
    error: 'conflict',
    field,
    message,
    ...extra
  };
}

function patientInScopeOrDenied(auth, patient, permission, contextMessage) {
  if (!patient) {
    return {
      ok: false,
      status: 404,
      error: 'patient_not_found',
      message: 'El paciente solicitado no existe.'
    };
  }
  if (!withinScope(auth.access, patient.establishment_id)) {
    return denyPermission(auth, {
      permission,
      entity: patient.id,
      establishmentId: patient.establishment_id,
      deniedKind: 'scope',
      message: contextMessage,
      detail: `Paciente ${patient.id} fuera de alcance`
    });
  }
  return null;
}

function refreshAuthContext(auth, db) {
  const refreshedUser = findUserById(db, auth.user.id) || auth.user;
  const refreshedSession = (db.sessions || []).find((item) => item.id === auth.session.id) || auth.session;
  return {
    user: refreshedUser,
    session: refreshedSession,
    access: buildAccessContext(auth.runtime, db, refreshedUser)
  };
}

function mutationPayload(auth, db, message, extras = {}) {
  const refreshed = refreshAuthContext(auth, db);
  return {
    status: 'ok',
    message,
    bootstrap: composeBootstrap(auth.runtime, db, refreshed.user, refreshed.session),
    ...extras
  };
}

function activeContactChannels(db, patientId) {
  return new Set(
    contactsForPatient(db, patientId)
      .filter((item) => item.active)
      .map((item) => item.channel)
  );
}

function activeContactsForPatient(db, patientId) {
  return contactsForPatient(db, patientId).filter((item) => item.active);
}

function patientConsentAllows(db, patientId, purpose, channel) {
  return (db.consents || []).some((item) =>
    item.patient_id === patientId &&
    item.purpose === purpose &&
    item.status === 'vigente' &&
    item.granted === true &&
    ((item.channel_scope || []).length === 0 || (item.channel_scope || []).includes(channel))
  );
}

function visibleContactBody(message) {
  return message.contains_sensitive_detail ? 'Detalle sensible protegido por canal.' : message.body;
}

function contactabilityStatusFor(patient, preference, contacts) {
  if (!patient?.contactable) {
    return {
      allowed: false,
      reason: 'Paciente marcado como no contactable.'
    };
  }
  if (!contacts.length) {
    return {
      allowed: false,
      reason: 'El paciente no tiene contactos activos.'
    };
  }
  if (!preference?.allow_non_urgent) {
    return {
      allowed: false,
      reason: 'Las preferencias del paciente bloquean comunicaciones no urgentes.'
    };
  }
  return {
    allowed: true,
    reason: null
  };
}

function selectableContacts(db, patientId, channel) {
  return activeContactsForPatient(db, patientId).filter((item) =>
    item.channel === channel &&
    item.excluded_from_non_urgent !== true
  );
}

function validateTemplatePayload(body, currentTemplate = null) {
  const code = normalizeText(body.code ?? currentTemplate?.code).toUpperCase();
  const name = normalizeText(body.name ?? currentTemplate?.name);
  const channel = normalizeText(body.channel ?? currentTemplate?.channel);
  const purpose = normalizeText(body.purpose ?? currentTemplate?.purpose);
  const language = normalizeText((body.language ?? currentTemplate?.language) || 'espanol');
  const status = normalizeText((body.status ?? currentTemplate?.status) || 'draft');
  const content = normalizeText(body.content ?? currentTemplate?.content);
  const version = Number(body.version ?? currentTemplate?.version ?? 1);
  const containsSensitiveDetail = Boolean(body.contains_sensitive_detail ?? currentTemplate?.contains_sensitive_detail ?? false);

  if (!code) {
    return validationError('El codigo de plantilla es obligatorio.', 'code');
  }
  if (!name) {
    return validationError('El nombre de plantilla es obligatorio.', 'name');
  }
  if (!CONTACT_CHANNELS_SUPPORTED.has(channel)) {
    return validationError('El canal de plantilla no es valido.', 'channel');
  }
  if (!purpose) {
    return validationError('La plantilla debe declarar finalidad sanitaria.', 'purpose');
  }
  if (!content) {
    return validationError('El contenido de plantilla no puede ser vacio.', 'content');
  }
  if (!CONTACT_TEMPLATE_STATUSES.has(status)) {
    return validationError('El estado de plantilla no es valido.', 'status');
  }
  if (!LANGUAGES.has(language)) {
    return validationError('El idioma de plantilla no es valido.', 'language');
  }
  if (!Number.isInteger(version) || version < 1) {
    return validationError('La version de plantilla debe ser un entero positivo.', 'version');
  }

  return {
    ok: true,
    value: {
      code,
      name,
      channel,
      purpose,
      language,
      status,
      content,
      version,
      contains_sensitive_detail: containsSensitiveDetail
    }
  };
}

function validateContactSendPayload(db, body) {
  const patientId = normalizeText(body.patient_id);
  const templateId = normalizeText(body.template_id);
  const purpose = normalizeText(body.purpose);
  const channel = normalizeText(body.channel);
  const detail = normalizeText(body.detail);
  const sensitive = Boolean(body.contains_sensitive_detail);
  const patient = findPatientById(db, patientId);
  const template = findContactTemplateById(db, templateId);

  if (!patient) {
    return {
      ok: false,
      status: 404,
      error: 'patient_not_found',
      message: 'El paciente solicitado no existe.'
    };
  }
  if (!template) {
    return {
      ok: false,
      status: 404,
      error: 'template_not_found',
      message: 'La plantilla solicitada no existe.'
    };
  }
  if (template.status !== 'active') {
    return conflictError('Solo puedes usar plantillas activas.', 'template_id');
  }
  if (!purpose) {
    return validationError('El envio debe registrar finalidad sanitaria.', 'purpose');
  }
  if (template.purpose !== purpose) {
    return validationError('La finalidad debe coincidir con la plantilla seleccionada.', 'purpose');
  }
  if (!CONTACT_CHANNELS_SUPPORTED.has(channel)) {
    return validationError('El canal solicitado no es valido.', 'channel');
  }
  if (template.channel !== channel) {
    return validationError('El canal del envio debe coincidir con la plantilla.', 'channel');
  }
  if (sensitive && CONTACT_CHANNELS_INSECURE_FOR_SENSITIVE.has(channel)) {
    return {
      ok: false,
      status: 422,
      error: 'sensitive_channel_blocked',
      field: 'channel',
      message: 'El canal seleccionado no permite detalle sensible.'
    };
  }
  const preference = preferencesForPatient(db, patientId);
  const contacts = selectableContacts(db, patientId, channel);
  const contactability = contactabilityStatusFor(patient, preference, contacts);
  if (!contactability.allowed) {
    return {
      ok: false,
      status: 409,
      error: 'not_contactable',
      field: 'patient_id',
      message: contactability.reason
    };
  }
  if (!patientConsentAllows(db, patientId, purpose, channel)) {
    return {
      ok: false,
      status: 422,
      error: 'consent_required',
      field: 'purpose',
      message: 'No existe consentimiento vigente para esa finalidad y canal.'
    };
  }
  if (!detail) {
    return validationError('Debes registrar el mensaje operativo a enviar.', 'detail');
  }
  return {
    ok: true,
    value: {
      patient,
      template,
      preference,
      contact: contacts[0],
      purpose,
      channel,
      detail,
      contains_sensitive_detail: sensitive
    }
  };
}

function validateContactWebhookPayload(db, body) {
  const messageId = normalizeText(body.message_id);
  const status = normalizeText(body.status);
  const result = normalizeText(body.result);
  const detail = normalizeText(body.detail);
  const message = findContactMessageById(db, messageId);
  if (!message) {
    return {
      ok: false,
      status: 404,
      error: 'contact_message_not_found',
      message: 'El envio solicitado no existe.'
    };
  }
  if (!CONTACT_MESSAGE_STATUSES.has(status)) {
    return validationError('El estado del webhook no es valido.', 'status');
  }
  if (!CONTACT_MESSAGE_RESULTS.has(result)) {
    return validationError('El resultado del webhook no es valido.', 'result');
  }
  if (!detail) {
    return validationError('El webhook requiere detalle.', 'detail');
  }
  return {
    ok: true,
    value: {
      message,
      status,
      result,
      detail
    }
  };
}

function validateCampaignPayload(db, body, currentCampaign = null) {
  const name = normalizeText(body.name ?? currentCampaign?.name);
  const purpose = normalizeText(body.purpose ?? currentCampaign?.purpose);
  const channel = normalizeText(body.channel ?? currentCampaign?.channel);
  const audience = normalizeText(body.audience ?? currentCampaign?.audience);
  const establishmentId = normalizeText(body.establishment_id ?? currentCampaign?.establishment_id);
  const templateId = normalizeText(body.template_id ?? currentCampaign?.template_id);
  const surveyId = normalizeNullableText(body.survey_id ?? currentCampaign?.survey_id);
  const status = normalizeText((body.status ?? currentCampaign?.status) || 'draft');
  const segmentationMode = normalizeText((body.segmentation_mode ?? currentCampaign?.segmentation_mode) || 'manual');

  if (!name) {
    return validationError('La campana debe indicar nombre.', 'name');
  }
  if (!purpose) {
    return validationError('La campana debe registrar finalidad sanitaria.', 'purpose');
  }
  if (!CONTACT_CHANNELS_SUPPORTED.has(channel)) {
    return validationError('El canal de campana no es valido.', 'channel');
  }
  if (!audience) {
    return validationError('La campana debe registrar segmento manual.', 'audience');
  }
  if (segmentationMode !== 'manual') {
    return validationError('La segmentacion automatica no esta aprobada para Quilicura.', 'segmentation_mode');
  }
  if (!establishmentId || !findEstablishmentById(db, establishmentId)) {
    return validationError('La campana debe apuntar a un establecimiento valido.', 'establishment_id');
  }
  const template = findContactTemplateById(db, templateId);
  if (!template) {
    return {
      ok: false,
      status: 404,
      error: 'template_not_found',
      message: 'La plantilla aprobada solicitada no existe.'
    };
  }
  if (template.status !== 'active') {
    return conflictError('La campana requiere una plantilla activa.', 'template_id');
  }
  if (template.purpose !== purpose) {
    return validationError('La finalidad de la campana debe coincidir con la plantilla.', 'purpose');
  }
  if (template.channel !== channel) {
    return validationError('El canal de la campana debe coincidir con la plantilla.', 'channel');
  }
  if (!CAMPAIGN_STATUSES.has(status)) {
    return validationError('El estado de campana no es valido.', 'status');
  }
  let survey = null;
  if (surveyId) {
    survey = findSurveyById(db, surveyId);
    if (!survey) {
      return {
        ok: false,
        status: 404,
        error: 'survey_not_found',
        message: 'La encuesta asociada no existe.'
      };
    }
    if (survey.status !== 'active') {
      return conflictError('La encuesta asociada debe estar activa.', 'survey_id');
    }
    if (survey.purpose !== purpose) {
      return validationError('La encuesta asociada debe compartir la misma finalidad.', 'survey_id');
    }
  }
  return {
    ok: true,
    value: {
      name,
      purpose,
      channel,
      audience,
      establishment_id: establishmentId,
      template_id: templateId,
      survey_id: surveyId,
      survey,
      status,
      segmentation_mode: segmentationMode,
      template
    }
  };
}

function validateCampaignApprovalPayload(body) {
  const approvalNote = normalizeText(body.approval_note);
  if (!approvalNote) {
    return validationError('La aprobacion debe dejar una nota auditable.', 'approval_note');
  }
  return {
    ok: true,
    value: {
      approval_note: approvalNote
    }
  };
}

function validateCampaignSchedulePayload(body) {
  const scheduledAt = normalizeText(body.scheduled_at);
  const executionNote = normalizeText(body.execution_note);
  if (!scheduledAt || !parseDate(scheduledAt)) {
    return validationError('La programacion requiere fecha y hora validas.', 'scheduled_at');
  }
  if (!executionNote) {
    return validationError('La programacion debe registrar una nota operativa.', 'execution_note');
  }
  return {
    ok: true,
    value: {
      scheduled_at: new Date(scheduledAt).toISOString(),
      execution_note: executionNote
    }
  };
}

function validateSurveyResponsePayload(body) {
  const campaignId = normalizeText(body.campaign_id);
  const patientId = normalizeText(body.patient_id);
  const score = Number(body.score);
  const comment = normalizeNullableText(body.comment);
  const channel = normalizeText(body.channel || 'telefono');
  if (!campaignId) {
    return validationError('La respuesta debe indicar campana origen.', 'campaign_id');
  }
  if (!patientId) {
    return validationError('La respuesta debe indicar paciente.', 'patient_id');
  }
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return validationError('La encuesta debe registrar puntaje entre 1 y 5.', 'score');
  }
  if (!CONTACT_CHANNELS_SUPPORTED.has(channel)) {
    return validationError('El canal de respuesta no es valido.', 'channel');
  }
  if (normalizeNullableText(body.clinical_detail)) {
    return validationError('La encuesta no puede pedir detalle clinico innecesario.', 'clinical_detail');
  }
  return {
    ok: true,
    value: {
      campaign_id: campaignId,
      patient_id: patientId,
      score,
      comment,
      channel
    }
  };
}

function validateSidraEventPayload(db, body) {
  const type = normalizeText(body.type);
  const entity = normalizeText(body.entity);
  const entityId = normalizeText(body.entity_id);
  const establishmentId = normalizeText(body.establishment_id);
  const simulationDefaultResult = normalizeText(body.simulation_default_result || 'acknowledged');
  const payload = typeof body.payload === 'object' && body.payload !== null ? body.payload : {};

  if (!type) {
    return validationError('El evento SIDRA requiere tipo.', 'type');
  }
  if (!SIDRA_ENTITIES.has(entity)) {
    return validationError('La entidad SIDRA no es valida.', 'entity');
  }
  if (!entityId) {
    return validationError('El evento SIDRA requiere entity_id.', 'entity_id');
  }
  if (!findEstablishmentById(db, establishmentId)) {
    return validationError('El evento SIDRA requiere establecimiento valido.', 'establishment_id');
  }
  if (!SIDRA_PROCESS_RESULTS.has(simulationDefaultResult)) {
    return validationError('La simulacion por defecto de SIDRA no es valida.', 'simulation_default_result');
  }

  if (entity === 'appointment') {
    const appointment = findAppointmentById(db, entityId);
    if (!appointment) {
      return {
        ok: false,
        status: 404,
        error: 'appointment_not_found',
        message: 'La cita referenciada para SIDRA no existe.'
      };
    }
    if (appointment.establishment_id !== establishmentId) {
      return validationError('La cita referenciada no pertenece al establecimiento indicado.', 'establishment_id');
    }
  }

  if (entity === 'waitlist') {
    const waitlist = findWaitlistEntryById(db, entityId);
    if (!waitlist) {
      return {
        ok: false,
        status: 404,
        error: 'waitlist_not_found',
        message: 'La espera referenciada para SIDRA no existe.'
      };
    }
    if (waitlist.establishment_id !== establishmentId) {
      return validationError('La espera referenciada no pertenece al establecimiento indicado.', 'establishment_id');
    }
  }

  if (entity === 'contact_case') {
    const contactCase = findContactCaseById(db, entityId);
    if (!contactCase) {
      return {
        ok: false,
        status: 404,
        error: 'contact_case_not_found',
        message: 'El caso de contactabilidad referenciado no existe.'
      };
    }
    if (contactCase.establishment_id !== establishmentId) {
      return validationError('El caso referenciado no pertenece al establecimiento indicado.', 'establishment_id');
    }
  }

  if (entity === 'patient') {
    const patient = findPatientById(db, entityId);
    if (!patient) {
      return {
        ok: false,
        status: 404,
        error: 'patient_not_found',
        message: 'El paciente referenciado para SIDRA no existe.'
      };
    }
    if (patient.establishment_id !== establishmentId) {
      return validationError('El paciente referenciado no pertenece al establecimiento indicado.', 'establishment_id');
    }
  }

  return {
    ok: true,
    value: {
      type,
      entity,
      entity_id: entityId,
      establishment_id: establishmentId,
      simulation_default_result: simulationDefaultResult,
      payload
    }
  };
}

function validateSidraProcessingPayload(body) {
  const result = normalizeText(body.result);
  const detail = normalizeText(body.detail);
  const errorCode = normalizeNullableText(body.error_code);
  if (!SIDRA_PROCESS_RESULTS.has(result)) {
    return validationError('El resultado SIDRA no es valido.', 'result');
  }
  if (!detail) {
    return validationError('La transicion SIDRA requiere detalle.', 'detail');
  }
  return {
    ok: true,
    value: {
      result,
      detail,
      error_code: errorCode
    }
  };
}

function validatePatientPayload(db, body, currentPatient = null) {
  const identifierKind = normalizeText(body.identifier_kind || currentPatient?.identifier_kind || 'definitive');
  const rut = normalizeNullableText(body.rut ?? currentPatient?.rut);
  const transientReason = normalizeNullableText(body.transient_reason ?? currentPatient?.transient_reason);
  const legalName = normalizeText(body.legal_name ?? currentPatient?.legal_name);
  const socialName = normalizeNullableText(body.social_name ?? currentPatient?.social_name);
  const birthDate = normalizeText(body.birth_date ?? currentPatient?.birth_date);
  const status = normalizeText((body.status ?? currentPatient?.status) || 'activo');
  const establishmentId = normalizeText(body.establishment_id ?? currentPatient?.establishment_id);
  const sector = normalizeNullableText(body.sector ?? currentPatient?.sector);
  const risk = normalizeNullableText(body.risk ?? currentPatient?.risk);
  const notes = normalizeNullableText(body.notes ?? currentPatient?.notes);
  const closureReason = normalizeNullableText(body.closure_reason);

  if (!legalName) {
    return validationError('El nombre legal es obligatorio.', 'legal_name');
  }
  if (!birthDate || !parseDate(birthDate)) {
    return validationError('La fecha de nacimiento es obligatoria.', 'birth_date');
  }
  if (parseDate(birthDate) > Date.now()) {
    return validationError('La fecha de nacimiento no puede ser futura.', 'birth_date');
  }
  if (!PATIENT_STATUSES.has(status)) {
    return validationError('El estado del paciente no es valido.', 'status');
  }
  if (!findEstablishmentById(db, establishmentId)) {
    return validationError('El establecimiento es obligatorio.', 'establishment_id');
  }
  if (identifierKind !== 'definitive' && identifierKind !== 'transient') {
    return validationError('El tipo de identificador no es valido.', 'identifier_kind');
  }
  if (identifierKind === 'definitive') {
    if (!rut || !validRut(rut)) {
      return validationError('El RUT debe tener formato valido.', 'rut');
    }
    const duplicated = (db.patients || []).find((item) =>
      item.id !== currentPatient?.id &&
      item.identifier_kind === 'definitive' &&
      canonicalRut(item.rut) === canonicalRut(rut)
    );
    if (duplicated) {
      return conflictError('Ya existe un paciente con ese RUT.', 'rut', {
        duplicated_patient_id: duplicated.id
      });
    }
  } else if (!transientReason) {
    return validationError('El identificador transitorio requiere motivo documentado.', 'transient_reason');
  }
  if (status !== 'activo' && currentPatient && currentPatient.status !== status && !closureReason) {
    return validationError('Debes registrar un motivo de cierre logico.', 'closure_reason');
  }

  return {
    ok: true,
    value: {
      identifier_kind: identifierKind,
      rut: identifierKind === 'definitive' ? rut : null,
      transient_reason: identifierKind === 'transient' ? transientReason : null,
      legal_name: legalName,
      social_name: socialName,
      birth_date: birthDate,
      status,
      establishment_id: establishmentId,
      sector,
      risk,
      notes,
      closure_reason: closureReason
    }
  };
}

function validateRepresentativePayload(body, currentRepresentative = null) {
  const legalName = normalizeText(body.legal_name ?? currentRepresentative?.legal_name);
  const relation = normalizeText(body.relation ?? currentRepresentative?.relation);
  const phone = normalizeNullableText(body.phone ?? currentRepresentative?.phone);
  const status = normalizeText((body.status ?? currentRepresentative?.status) || 'vigente');
  const notes = normalizeNullableText(body.notes ?? currentRepresentative?.notes);
  const verified = body.verified ?? currentRepresentative?.verified ?? false;

  if (!legalName) {
    return validationError('El representante requiere nombre legal.', 'legal_name');
  }
  if (!relation) {
    return validationError('El representante vigente debe indicar relacion.', 'relation');
  }
  if (phone && !validPhone(phone)) {
    return validationError('El telefono del representante no es valido.', 'phone');
  }
  return {
    ok: true,
    value: {
      legal_name: legalName,
      relation,
      phone,
      status,
      notes,
      verified: Boolean(verified)
    }
  };
}

function validChannelsForType(type) {
  if (type === 'telefono') {
    return new Set(['telefono', 'sms', 'whatsapp']);
  }
  if (type === 'correo') {
    return new Set(['correo']);
  }
  if (type === 'domicilio') {
    return new Set(['domicilio']);
  }
  return new Set(['otro']);
}

function validateContactPayload(body, currentContact = null) {
  const type = normalizeText(body.type ?? currentContact?.type);
  const channel = normalizeText(body.channel ?? currentContact?.channel ?? type);
  const label = normalizeText(body.label ?? currentContact?.label);
  const value = normalizeText(body.value ?? currentContact?.value);
  const source = normalizeNullableText(body.source ?? currentContact?.source) || 'gestion_local';
  const active = body.active ?? currentContact?.active ?? true;
  const verified = body.verified ?? currentContact?.verified ?? false;
  const excluded = body.excluded_from_non_urgent ?? currentContact?.excluded_from_non_urgent ?? false;

  if (!CONTACT_TYPES.has(type)) {
    return validationError('El tipo de contacto no es valido.', 'type');
  }
  if (!CONTACT_CHANNELS.has(channel) || !validChannelsForType(type).has(channel)) {
    return validationError('El canal no corresponde al tipo de contacto.', 'channel');
  }
  if (!label) {
    return validationError('La etiqueta del contacto es obligatoria.', 'label');
  }
  if (!value) {
    return validationError('El valor del contacto no puede ser vacio.', 'value');
  }
  if (type === 'telefono' && !validPhone(value)) {
    return validationError('El telefono debe usar prefijo y longitud permitidos.', 'value');
  }
  if (type === 'correo' && !validEmail(value)) {
    return validationError('El correo no tiene formato valido.', 'value');
  }
  return {
    ok: true,
    value: {
      type,
      channel,
      label,
      value,
      source,
      active: Boolean(active),
      verified: Boolean(verified),
      excluded_from_non_urgent: Boolean(excluded)
    }
  };
}

function validatePreferencePayload(db, patientId, body, currentPreference = null) {
  const preferredChannel = normalizeNullableText(body.preferred_channel ?? currentPreference?.preferred_channel);
  const language = normalizeText(body.language ?? currentPreference?.language ?? 'espanol');
  const notes = normalizeNullableText(body.notes ?? currentPreference?.notes);
  const allowNonUrgent = body.allow_non_urgent ?? currentPreference?.allow_non_urgent ?? true;
  const excludedContactIds = Array.isArray(body.excluded_contact_ids)
    ? body.excluded_contact_ids.map((item) => String(item))
    : currentPreference?.excluded_contact_ids || [];

  if (preferredChannel && !CONTACT_CHANNELS.has(preferredChannel)) {
    return validationError('La preferencia referencia un canal no permitido.', 'preferred_channel');
  }
  if (!LANGUAGES.has(language)) {
    return validationError('El idioma preferido no es valido.', 'language');
  }
  const channels = activeContactChannels(db, patientId);
  if (preferredChannel && !channels.has(preferredChannel)) {
    return validationError('La preferencia debe referenciar un canal activo del paciente.', 'preferred_channel');
  }
  return {
    ok: true,
    value: {
      patient_id: patientId,
      preferred_channel: preferredChannel,
      language,
      allow_non_urgent: Boolean(allowNonUrgent),
      excluded_contact_ids: excludedContactIds,
      notes
    }
  };
}

function validateConsentPayload(body, currentConsent = null) {
  const purpose = normalizeText(body.purpose ?? currentConsent?.purpose);
  const source = normalizeNullableText(body.source ?? currentConsent?.source) || 'gestion_local';
  const notes = normalizeNullableText(body.notes ?? currentConsent?.notes);
  const granted = body.granted ?? currentConsent?.granted ?? true;
  const requestedStatus = normalizeText(body.status ?? currentConsent?.status ?? (granted ? 'vigente' : 'revocado'));
  const channelScope = Array.isArray(body.channel_scope) ? body.channel_scope.map((item) => String(item)) : currentConsent?.channel_scope || [];

  if (!purpose) {
    return validationError('El consentimiento debe indicar finalidad.', 'purpose');
  }
  if (!CONSENT_STATUSES.has(requestedStatus)) {
    return validationError('El estado del consentimiento no es valido.', 'status');
  }
  if (channelScope.some((item) => !CONTACT_CHANNELS.has(item))) {
    return validationError('El alcance por canal del consentimiento no es valido.', 'channel_scope');
  }
  return {
    ok: true,
    value: {
      purpose,
      source,
      notes,
      granted: Boolean(granted),
      status: requestedStatus,
      channel_scope: channelScope
    }
  };
}

function validateAgendaEntityStatus(value, field) {
  if (!AGENDA_ENTITY_STATUSES.has(value)) {
    return validationError('El estado de la entidad de agenda no es valido.', field);
  }
  return null;
}

function validateProfessionalPayload(db, body, currentProfessional = null) {
  const name = normalizeText(body.name ?? currentProfessional?.name);
  const discipline = normalizeText(body.discipline ?? currentProfessional?.discipline);
  const establishmentId = normalizeText(body.establishment_id ?? currentProfessional?.establishment_id);
  const status = normalizeText(body.status ?? currentProfessional?.status ?? 'active');
  if (!name) {
    return validationError('El profesional requiere nombre visible.', 'name');
  }
  if (!discipline) {
    return validationError('La disciplina del profesional es obligatoria.', 'discipline');
  }
  if (!findEstablishmentById(db, establishmentId)) {
    return validationError('El establecimiento del profesional es obligatorio.', 'establishment_id');
  }
  const invalidStatus = validateAgendaEntityStatus(status, 'status');
  if (invalidStatus) {
    return invalidStatus;
  }
  return {
    ok: true,
    value: {
      name,
      discipline,
      establishment_id: establishmentId,
      status
    }
  };
}

function validateServicePayload(db, body, currentService = null) {
  const name = normalizeText(body.name ?? currentService?.name);
  const code = normalizeText(body.code ?? currentService?.code);
  const establishmentId = normalizeText(body.establishment_id ?? currentService?.establishment_id);
  const status = normalizeText(body.status ?? currentService?.status ?? 'active');
  const durationMinutes = Number(body.duration_minutes ?? currentService?.duration_minutes ?? 30);
  if (!name) {
    return validationError('La prestacion requiere nombre.', 'name');
  }
  if (!code) {
    return validationError('La prestacion requiere codigo.', 'code');
  }
  if (!findEstablishmentById(db, establishmentId)) {
    return validationError('El establecimiento de la prestacion es obligatorio.', 'establishment_id');
  }
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    return validationError('La duracion de la prestacion debe ser positiva.', 'duration_minutes');
  }
  const invalidStatus = validateAgendaEntityStatus(status, 'status');
  if (invalidStatus) {
    return invalidStatus;
  }
  return {
    ok: true,
    value: {
      name,
      code,
      duration_minutes: durationMinutes,
      establishment_id: establishmentId,
      status
    }
  };
}

function validateAgendaPayload(db, body, currentAgenda = null) {
  const name = normalizeText(body.name ?? currentAgenda?.name);
  const establishmentId = normalizeText(body.establishment_id ?? currentAgenda?.establishment_id);
  const professionalId = normalizeText(body.professional_id ?? currentAgenda?.professional_id);
  const serviceId = normalizeText(body.service_id ?? currentAgenda?.service_id);
  const status = normalizeText(body.status ?? currentAgenda?.status ?? 'active');
  if (!name) {
    return validationError('La agenda requiere nombre.', 'name');
  }
  if (!findEstablishmentById(db, establishmentId)) {
    return validationError('La agenda requiere establecimiento valido.', 'establishment_id');
  }
  const professional = findProfessionalById(db, professionalId);
  if (!professional || professional.establishment_id !== establishmentId) {
    return validationError('La agenda requiere profesional vigente del mismo establecimiento.', 'professional_id');
  }
  const service = findServiceById(db, serviceId);
  if (!service || service.establishment_id !== establishmentId) {
    return validationError('La agenda requiere prestacion vigente del mismo establecimiento.', 'service_id');
  }
  const invalidStatus = validateAgendaEntityStatus(status, 'status');
  if (invalidStatus) {
    return invalidStatus;
  }
  return {
    ok: true,
    value: {
      name,
      establishment_id: establishmentId,
      professional_id: professionalId,
      service_id: serviceId,
      status
    }
  };
}

function validateSlotPayload(db, body, currentSlot = null) {
  const agendaId = normalizeText(body.agenda_id ?? currentSlot?.agenda_id);
  const agenda = findAgendaById(db, agendaId);
  if (!agenda) {
    return validationError('El cupo requiere una agenda valida.', 'agenda_id');
  }
  const startsAt = normalizeText(body.starts_at ?? currentSlot?.starts_at);
  const endsAt = normalizeText(body.ends_at ?? currentSlot?.ends_at);
  const status = normalizeText(body.status ?? currentSlot?.status ?? 'disponible');
  if (!startsAt || !parseDate(startsAt)) {
    return validationError('El cupo requiere fecha y hora de inicio.', 'starts_at');
  }
  if (!endsAt || !parseDate(endsAt)) {
    return validationError('El cupo requiere fecha y hora de termino.', 'ends_at');
  }
  if (parseDate(endsAt) <= parseDate(startsAt)) {
    return validationError('La hora de termino debe ser posterior al inicio.', 'ends_at');
  }
  if (!SLOT_STATUSES.has(status)) {
    return validationError('El estado del cupo no es valido.', 'status');
  }
  const sameResourceOverlap = (db.slots || []).find((slot) =>
    slot.id !== currentSlot?.id &&
    slot.agenda_id === agendaId &&
    slot.status !== 'bloqueado' &&
    parseDate(slot.starts_at) < parseDate(endsAt) &&
    parseDate(startsAt) < parseDate(slot.ends_at)
  );
  if (sameResourceOverlap) {
    return conflictError('El cupo se solapa con otro cupo activo de la agenda.', 'starts_at', {
      conflicting_slot_id: sameResourceOverlap.id
    });
  }
  return {
    ok: true,
    value: {
      agenda_id: agenda.id,
      establishment_id: agenda.establishment_id,
      professional_id: agenda.professional_id,
      service_id: agenda.service_id,
      professional: findProfessionalById(db, agenda.professional_id)?.name || agenda.professional_id,
      service: findServiceById(db, agenda.service_id)?.name || agenda.service_id,
      starts_at: startsAt,
      ends_at: endsAt,
      day: slotDayLabel(startsAt),
      time: slotTimeLabel(startsAt),
      status,
      note: normalizeNullableText(body.note ?? currentSlot?.note) || null
    }
  };
}

function validateAppointmentCreation(db, body) {
  const patientId = normalizeText(body.patient_id ?? body.patientId);
  const slotId = normalizeText(body.slot_id ?? body.slotId);
  const channel = normalizeText(body.channel || 'meson');
  const note = normalizeNullableText(body.note) || null;
  const origin = normalizeText(body.origin || 'portal_funcionario');
  const patient = findPatientById(db, patientId);
  if (!patient) {
    return {
      ok: false,
      status: 404,
      error: 'patient_not_found',
      message: 'El paciente solicitado no existe.'
    };
  }
  const slot = findSlotById(db, slotId);
  if (!slot) {
    return {
      ok: false,
      status: 404,
      error: 'slot_not_found',
      message: 'El cupo solicitado no existe.'
    };
  }
  if (slot.status === 'bloqueado') {
    return conflictError('No se puede crear una cita sobre un cupo bloqueado.', 'slot_id');
  }
  if (slot.status === 'reservado') {
    return conflictError('No se puede crear una cita sobre un cupo ya reservado.', 'slot_id');
  }
  if (slotIsPast(slot)) {
    return conflictError('No se puede crear una cita sobre un cupo vencido.', 'slot_id');
  }
  return {
    ok: true,
    value: {
      patient,
      slot,
      channel,
      note,
      origin
    }
  };
}

function validateWaitlistPayload(db, body, currentEntry = null) {
  const patientId = normalizeText(body.patient_id ?? body.patientId ?? currentEntry?.patientId);
  const serviceId = normalizeText(body.service_id ?? body.serviceId ?? currentEntry?.service_id);
  const establishmentId = normalizeText(body.establishment_id ?? currentEntry?.establishment_id);
  const note = normalizeNullableText(body.note ?? currentEntry?.note) || null;
  const source = normalizeText(body.source ?? currentEntry?.source ?? 'sin_cupo_manual');
  const patient = findPatientById(db, patientId);
  const service = findServiceById(db, serviceId);
  const establishment = findEstablishmentById(db, establishmentId);
  if (!patient) {
    return {
      ok: false,
      status: 404,
      error: 'patient_not_found',
      message: 'El paciente solicitado no existe.'
    };
  }
  if (!service) {
    return {
      ok: false,
      status: 404,
      error: 'service_not_found',
      message: 'La prestacion indicada no existe.'
    };
  }
  if (!establishment) {
    return validationError('La espera requiere establecimiento valido.', 'establishment_id');
  }
  if (patient.establishment_id !== establishmentId) {
    return validationError('El paciente debe pertenecer al establecimiento de la espera.', 'establishment_id');
  }
  if (service.establishment_id !== establishmentId) {
    return validationError('La prestacion debe corresponder al establecimiento solicitado.', 'service_id');
  }
  return {
    ok: true,
    value: {
      patient,
      service,
      establishment,
      patient_id: patientId,
      service_id: serviceId,
      establishment_id: establishmentId,
      note,
      source
    }
  };
}

function appendAppointmentHistory(db, entry) {
  const record = {
    id: nextSequenceId(db.appointment_history || [], 'AH'),
    appointment_id: entry.appointment_id,
    action: entry.action,
    from_status: entry.from_status || null,
    to_status: entry.to_status || null,
    slot_id: entry.slot_id || null,
    related_appointment_id: entry.related_appointment_id || null,
    actor: entry.actor || 'system',
    role: entry.role || 'system',
    detail: entry.detail || '',
    at: isoNow()
  };
  return {
    ...db,
    appointment_history: [record, ...(db.appointment_history || [])].slice(0, 600)
  };
}

function appendWaitlistEvent(db, entry) {
  const record = {
    id: nextSequenceId(db.waitlist_events || [], 'WE'),
    waitlist_id: entry.waitlist_id,
    type: entry.type,
    actor: entry.actor || 'system',
    role: entry.role || 'system',
    detail: entry.detail || '',
    rule_applied: entry.rule_applied || 'RL-01',
    slot_id: entry.slot_id || null,
    offer_id: entry.offer_id || null,
    appointment_id: entry.appointment_id || null,
    at: isoNow()
  };
  return {
    ...db,
    waitlist_events: [record, ...(db.waitlist_events || [])].slice(0, 600)
  };
}

function appendSidraAttempt(db, entry) {
  const record = {
    id: nextSequenceId(db.sidra_attempts || [], 'SDA'),
    sidra_event_id: entry.sidra_event_id,
    attempt_number: Number(entry.attempt_number || 1),
    status_before: entry.status_before || null,
    status_after: entry.status_after || null,
    result: entry.result || null,
    detail: entry.detail || '',
    actor: entry.actor || 'system',
    role: entry.role || 'system',
    at: isoNow()
  };
  return {
    ...db,
    sidra_attempts: [record, ...(db.sidra_attempts || [])].slice(0, 600)
  };
}

function sidraEventView(db, event, access, runtime) {
  const attempts = sidraAttemptsForEvent(db, event.id).slice(0, 8);
  const retries = Number(event.retries || 0);
  const maxRetries = Number(event.max_retries || sidraRetryLimit(runtime));
  return {
    ...event,
    retries,
    max_retries: maxRetries,
    establishment_name: findEstablishmentById(db, event.establishment_id)?.name || event.establishment_id,
    attempt_history: attempts,
    allowed_actions: {
      process: access.permissionsSet.has('sidra.manage') && withinScope(access, event.establishment_id) && sidraTransitionAllowed(event.status, 'process'),
      retry: access.permissionsSet.has('sidra.manage') && withinScope(access, event.establishment_id) && sidraTransitionAllowed(event.status, 'retry') && retries < maxRetries,
      resolve_discrepancy: access.permissionsSet.has('sidra.manage') && withinScope(access, event.establishment_id) && sidraTransitionAllowed(event.status, 'resolve_discrepancy')
    }
  };
}

function enqueueSidraEvent(db, runtime, actor, entry) {
  const timestamp = isoNow();
  const event = {
    id: nextSequenceId(db.sidra || [], 'SID'),
    correlation_id: entry.correlation_id || `${entry.entity}-${String(entry.entity_id || '').replaceAll('/', '-')}-${Date.now()}`,
    type: entry.type,
    entity: entry.entity,
    entity_id: entry.entity_id || null,
    establishment_id: entry.establishment_id || null,
    status: 'queued',
    retries: 0,
    max_retries: Number(entry.max_retries || sidraRetryLimit(runtime)),
    payload: entry.payload || {},
    simulation_default_result: entry.simulation_default_result || 'acknowledged',
    last_error: null,
    last_error_code: null,
    discrepancy_note: null,
    queued_at: timestamp,
    sent_at: null,
    acknowledged_at: null,
    resolved_at: null,
    updated_at: timestamp,
    updated_by: actor
  };
  return {
    db: {
      ...db,
      sidra: [event, ...(db.sidra || [])]
    },
    event
  };
}

function applySidraProcessResult(runtime, db, event, actor, role, result, detail, errorCode = null) {
  const attemptNumber = Number(event.retries || 0) + 1;
  const maxRetries = Number(event.max_retries || sidraRetryLimit(runtime));
  const timestamp = isoNow();
  let nextStatus = result;
  let nextRetryAt = null;
  let resolvedAt = null;
  let acknowledgedAt = event.acknowledged_at || null;
  let discrepancyNote = event.discrepancy_note || null;
  let lastError = null;
  let lastErrorCode = errorCode;

  if (result === 'acknowledged') {
    nextStatus = 'acknowledged';
    acknowledgedAt = timestamp;
    resolvedAt = timestamp;
  } else if (result === 'rejected') {
    nextStatus = 'rejected';
    resolvedAt = timestamp;
    lastError = detail || 'Evento rechazado por servicio SIDRA simulado.';
    lastErrorCode = errorCode || 'SIDRA_REJECTED';
  } else if (result === 'discrepancy') {
    nextStatus = 'discrepancy';
    discrepancyNote = detail || 'Discrepancia detectada en servicio SIDRA simulado.';
    lastError = discrepancyNote;
    lastErrorCode = errorCode || 'SIDRA_DISCREPANCY';
  } else {
    const canRetry = attemptNumber < maxRetries;
    nextStatus = canRetry ? 'retry_pending' : 'failed';
    nextRetryAt = canRetry ? new Date(Date.now() + sidraRetryDelayMinutes(runtime) * 60 * 1000).toISOString() : null;
    resolvedAt = canRetry ? null : timestamp;
    lastError = detail || 'Falla simulada en cola SIDRA local.';
    lastErrorCode = errorCode || 'SIDRA_FAILED';
  }

  const updated = {
    ...event,
    status: nextStatus,
    retries: attemptNumber,
    sent_at: timestamp,
    acknowledged_at: acknowledgedAt,
    resolved_at: resolvedAt,
    next_retry_at: nextRetryAt,
    last_error: lastError,
    last_error_code: lastErrorCode,
    discrepancy_note: discrepancyNote,
    updated_at: timestamp,
    updated_by: actor
  };

  let nextDb = {
    ...db,
    sidra: (db.sidra || []).map((item) => item.id === event.id ? updated : item)
  };
  nextDb = appendSidraAttempt(nextDb, {
    sidra_event_id: event.id,
    attempt_number: attemptNumber,
    status_before: event.status,
    status_after: nextStatus,
    result,
    detail: detail || '',
    actor,
    role
  });
  return {
    db: nextDb,
    event: updated
  };
}

function releaseOfferSlot(db, offer, actor, preserveReserved = false) {
  return {
    ...db,
    slots: (db.slots || []).map((slot) => slot.id === offer.slot_id ? {
      ...slot,
      status: preserveReserved ? slot.status : 'disponible',
      waitlist_offer_id: preserveReserved ? offer.id : null,
      reserved_for: preserveReserved ? slot.reserved_for : null,
      updated_at: isoNow(),
      updated_by: actor
    } : slot)
  };
}

function applyRuntimeMaintenance(runtime, db) {
  let nextDb = db;
  let changed = false;
  for (const offer of db.waitlist_offers || []) {
    if (offer.status !== 'pendiente_respuesta' || parseDate(offer.expires_at) > Date.now()) {
      continue;
    }
    changed = true;
    nextDb = {
      ...nextDb,
      waitlist_offers: (nextDb.waitlist_offers || []).map((item) => item.id === offer.id ? {
        ...item,
        status: 'expirada',
        resolved_at: isoNow(),
        resolution_reason: 'Oferta expirada por plazo local'
      } : item),
      waitlist: (nextDb.waitlist || []).map((entry) => entry.id === offer.waitlist_id ? {
        ...entry,
        status: 'activa',
        active_offer_id: null,
        updated_at: isoNow(),
        updated_by: 'system'
      } : entry)
    };
    nextDb = releaseOfferSlot(nextDb, offer, 'system');
    nextDb = appendWaitlistEvent(nextDb, {
      waitlist_id: offer.waitlist_id,
      type: 'waitlist.offer.expired',
      detail: `Oferta ${offer.id} expirada por plazo configurado`,
      slot_id: offer.slot_id,
      offer_id: offer.id
    });
    nextDb = appendAudit(nextDb, {
      actor: 'system',
      role: 'system',
      action: 'waitlist.offer.expired',
      entity: offer.id,
      result: 'pass',
      detail: `Oferta ${offer.id} expiro y libero ${offer.slot_id}`
    });
  }
  return {
    changed,
    db: nextDb
  };
}

export async function loginUser(username, password) {
  const runtime = await loadRuntime();
  let db = await loadDatabase();
  const user = findUserByUsername(db, username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    db = appendAudit(db, {
      actor: user?.username || 'anonymous',
      role: user?.role || 'anonymous',
      action: 'auth.login.failed',
      entity: 'session',
      result: 'denied',
      detail: 'Credenciales invalidas'
    });
    await saveDatabase(db);
    return {
      ok: false,
      status: 401,
      error: 'invalid_credentials',
      message: 'Credenciales invalidas.'
    };
  }
  if (user.status !== 'active') {
    db = appendAudit(db, {
      actor: user.username,
      role: user.role,
      action: 'auth.login.inactive',
      entity: 'session',
      result: 'denied',
      detail: 'Usuario inactivo'
    });
    await saveDatabase(db);
    return {
      ok: false,
      status: 403,
      error: 'user_inactive',
      message: 'Usuario interno inactivo. Solicita reactivacion.'
    };
  }
  const { token, record } = buildSession(db, runtime, user);
  db = {
    ...db,
    sessions: [record, ...(db.sessions || [])]
  };
  db = appendAudit(db, {
    actor: user.username,
    role: user.role,
    action: 'auth.login.success',
    entity: 'session',
    result: 'pass',
    detail: `Sesion creada para ${user.display_name}`
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    auth: {
      token,
      expires_at: record.expires_at
    },
    user: sanitizeUser(user)
  };
}

export async function requireSession(token, context = 'protected_resource') {
  const runtime = await loadRuntime();
  let db = await loadDatabase();
  const maintenance = applyRuntimeMaintenance(runtime, db);
  if (maintenance.changed) {
    db = maintenance.db;
    await saveDatabase(db);
  }
  if (!token) {
    db = appendAudit(db, {
      actor: 'anonymous',
      role: 'anonymous',
      action: 'auth.protected.denied',
      entity: context,
      result: 'denied',
      detail: 'Falta token de sesion'
    });
    return denyAuth(db, {
      status: 401,
      error: 'auth_required',
      message: 'Debes iniciar sesion para continuar.'
    });
  }

  const session = findSessionByToken(db, token);
  if (!session || session.revoked_at) {
    db = appendAudit(db, {
      actor: 'anonymous',
      role: 'anonymous',
      action: 'auth.protected.denied',
      entity: context,
      result: 'denied',
      detail: 'Token inexistente o revocado'
    });
    return denyAuth(db, {
      status: 401,
      error: 'auth_required',
      message: 'La sesion no es valida.'
    });
  }

  const user = findUserById(db, session.user_id);
  if (!user || user.status !== 'active') {
    db = {
      ...db,
      sessions: (db.sessions || []).map((item) => item.id === session.id ? {
        ...item,
        revoked_at: isoNow(),
        revoked_reason: 'user_inactive'
      } : item)
    };
    db = appendAudit(db, {
      actor: user?.username || session.user_id,
      role: user?.role || 'unknown',
      action: 'auth.session.invalid_user',
      entity: context,
      result: 'denied',
      detail: 'Usuario inactivo o inexistente'
    });
    return denyAuth(db, {
      status: 403,
      error: 'user_inactive',
      message: 'Usuario interno inactivo.'
    });
  }

  if (isSessionExpired(session)) {
    db = {
      ...db,
      sessions: (db.sessions || []).map((item) => item.id === session.id ? {
        ...item,
        revoked_at: isoNow(),
        revoked_reason: 'expired'
      } : item)
    };
    db = appendAudit(db, {
      actor: user.username,
      role: user.role,
      action: 'auth.session.expired',
      entity: context,
      result: 'denied',
      detail: 'La sesion expiro'
    });
    return denyAuth(db, {
      status: 401,
      error: 'session_expired',
      message: 'La sesion expiro. Ingresa nuevamente.'
    });
  }

  const nextSessions = (db.sessions || []).map((item) => item.id === session.id ? {
    ...item,
    last_seen_at: isoNow()
  } : item);
  db = {
    ...db,
    sessions: nextSessions
  };
  await saveDatabase(db);
  return {
    ok: true,
    runtime,
    db,
    user,
    session: nextSessions.find((item) => item.id === session.id) || session
  };
}

export async function authorize(token, permission, options = {}) {
  const auth = await requireSession(token, options.context || permission);
  if (!auth.ok) {
    return auth;
  }
  const access = buildAccessContext(auth.runtime, auth.db, auth.user);
  const scopedAuth = {
    ...auth,
    access
  };
  if (!access.permissionsSet.has(permission)) {
    return denyPermission(scopedAuth, {
      permission,
      entity: options.entity || permission,
      message: options.message || 'Tu rol no tiene permiso para esta accion.',
      detail: `Permiso faltante: ${permission}`
    });
  }
  if (options.establishmentId && !withinScope(access, options.establishmentId)) {
    return denyPermission(scopedAuth, {
      permission,
      entity: options.entity || options.establishmentId,
      establishmentId: options.establishmentId,
      deniedKind: 'scope',
      message: options.scopeMessage || 'Tu rol no tiene alcance sobre ese establecimiento.',
      detail: `Fuera de alcance para ${options.establishmentId}`
    });
  }
  return scopedAuth;
}

export async function getBootstrap(token) {
  const auth = await authorize(token, 'dashboard.view', {
    context: 'bootstrap',
    entity: 'bootstrap',
    message: 'Tu rol no puede abrir el portal operativo.'
  });
  if (!auth.ok) {
    return auth;
  }
  return {
    ok: true,
    status: 200,
    payload: composeBootstrap(auth.runtime, auth.db, auth.user, auth.session)
  };
}

export async function getSessionSnapshot(token) {
  const auth = await requireSession(token, 'session_snapshot');
  if (!auth.ok) {
    return auth;
  }
  const access = buildAccessContext(auth.runtime, auth.db, auth.user);
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      user: sanitizeUser(auth.user),
      session: {
        id: auth.session.id,
        created_at: auth.session.created_at,
        expires_at: auth.session.expires_at
      },
      runtime: {
        version: auth.runtime.version,
        phase: auth.runtime.phase,
        sidra_mode: auth.runtime.sidra_mode
      },
      rbac: rbacPayload(auth.db, access)
    }
  };
}

export async function listCampaignsV1(token) {
  const auth = await authorize(token, 'campaigns.read', {
    context: 'campaign_list',
    entity: 'campaigns',
    message: 'Tu rol no puede consultar campanas.'
  });
  if (!auth.ok) {
    return auth;
  }
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      items: campaignView(auth.db, filterEntities(auth.db.campaigns, auth.access, 'campaigns.read'), auth.access)
    }
  };
}

export async function createCampaignV1(token, body = {}) {
  const auth = await authorize(token, 'campaigns.manage', {
    context: 'campaign_create',
    entity: 'campaigns',
    message: 'Tu rol no puede crear campanas.'
  });
  if (!auth.ok) {
    return auth;
  }
  const validation = validateCampaignPayload(auth.db, body);
  if (!validation.ok) {
    return validation;
  }
  if (!withinScope(auth.access, validation.value.establishment_id)) {
    return denyPermission(auth, {
      permission: 'campaigns.manage',
      entity: validation.value.establishment_id,
      establishmentId: validation.value.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no puede crear campanas para ese establecimiento.',
      detail: `Fuera de alcance para ${validation.value.establishment_id}`
    });
  }
  const campaign = {
    id: nextSequenceId(auth.db.campaigns || [], 'CAM'),
    name: validation.value.name,
    purpose: validation.value.purpose,
    audience: validation.value.audience,
    channel: validation.value.channel,
    establishment_id: validation.value.establishment_id,
    template_id: validation.value.template_id,
    survey_id: validation.value.survey_id,
    segmentation_mode: validation.value.segmentation_mode,
    approval_status: 'draft',
    approval_note: null,
    approved_at: null,
    approved_by: null,
    scheduled_at: null,
    execution_note: null,
    status: 'draft',
    sent: 0,
    created_at: isoNow(),
    created_by: auth.user.username,
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    campaigns: [campaign, ...(auth.db.campaigns || [])]
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'campaign.create',
    entity: campaign.id,
    result: 'pass',
    detail: `Campana ${campaign.name} creada con finalidad ${campaign.purpose}`,
    after: deepClone(campaign)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 201,
    payload: mutationPayload(auth, db, 'Campana creada correctamente.', {
      campaign: campaignView(db, [campaign], refreshAuthContext(auth, db).access)[0]
    })
  };
}

export async function approveCampaignV1(token, campaignId, body = {}) {
  const auth = await authorize(token, 'campaigns.manage', {
    context: 'campaign_approve',
    entity: campaignId,
    message: 'Tu rol no puede aprobar campanas.'
  });
  if (!auth.ok) {
    return auth;
  }
  const campaign = findCampaignById(auth.db, campaignId);
  if (!campaign) {
    return {
      ok: false,
      status: 404,
      error: 'campaign_not_found',
      message: 'La campana solicitada no existe.'
    };
  }
  if (!withinScope(auth.access, campaign.establishment_id)) {
    return denyPermission(auth, {
      permission: 'campaigns.manage',
      entity: campaign.id,
      establishmentId: campaign.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no puede aprobar campanas de ese establecimiento.',
      detail: `Fuera de alcance para ${campaign.establishment_id}`
    });
  }
  const validation = validateCampaignApprovalPayload(body);
  if (!validation.ok) {
    return validation;
  }
  const updated = {
    ...campaign,
    approval_status: 'approved',
    approval_note: validation.value.approval_note,
    approved_at: isoNow(),
    approved_by: auth.user.username,
    status: 'approved',
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    campaigns: (auth.db.campaigns || []).map((item) => item.id === campaign.id ? updated : item)
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'campaign.approve',
    entity: campaign.id,
    result: 'pass',
    detail: validation.value.approval_note,
    before: deepClone(campaign),
    after: deepClone(updated)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, 'Campana aprobada.', {
      campaign: campaignView(db, [updated], refreshAuthContext(auth, db).access)[0]
    })
  };
}

export async function scheduleCampaignV1(token, campaignId, body = {}) {
  const auth = await authorize(token, 'campaigns.manage', {
    context: 'campaign_schedule',
    entity: campaignId,
    message: 'Tu rol no puede programar campanas.'
  });
  if (!auth.ok) {
    return auth;
  }
  const campaign = findCampaignById(auth.db, campaignId);
  if (!campaign) {
    return {
      ok: false,
      status: 404,
      error: 'campaign_not_found',
      message: 'La campana solicitada no existe.'
    };
  }
  if (!withinScope(auth.access, campaign.establishment_id)) {
    return denyPermission(auth, {
      permission: 'campaigns.manage',
      entity: campaign.id,
      establishmentId: campaign.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no puede programar campanas de ese establecimiento.',
      detail: `Fuera de alcance para ${campaign.establishment_id}`
    });
  }
  if (campaign.approval_status !== 'approved') {
    return conflictError('La campana debe aprobarse antes de programarse.', 'campaign_id');
  }
  const validation = validateCampaignSchedulePayload(body);
  if (!validation.ok) {
    return validation;
  }
  const recipients = filterEntities(auth.db.patients, auth.access, 'patients.read').filter((patient) =>
    patient.establishment_id === campaign.establishment_id &&
    patient.status === 'activo' &&
    patientConsentAllows(auth.db, patient.id, campaign.purpose, campaign.channel) &&
    selectableContacts(auth.db, patient.id, campaign.channel).length > 0
  ).map((patient) => ({
    id: nextSequenceId([
      ...(auth.db.campaign_recipients || []),
      ...[]
    ], 'CDR'),
    campaign_id: campaign.id,
    patient_id: patient.id,
    establishment_id: campaign.establishment_id,
    channel: campaign.channel,
    purpose: campaign.purpose,
    status: 'sent',
    created_at: isoNow()
  }));
  const recipientRecords = recipients.map((recipient, index) => ({
    ...recipient,
    id: `CDR-${String((auth.db.campaign_recipients || []).length + index + 1).padStart(4, '0')}`
  }));
  const updated = {
    ...campaign,
    scheduled_at: validation.value.scheduled_at,
    execution_note: validation.value.execution_note,
    status: 'scheduled',
    sent: recipientRecords.length,
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    campaigns: (auth.db.campaigns || []).map((item) => item.id === campaign.id ? updated : item),
    campaign_recipients: [...recipientRecords, ...(auth.db.campaign_recipients || [])]
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'campaign.schedule',
    entity: campaign.id,
    result: 'pass',
    detail: `${recipientRecords.length} destinatarios elegibles; ${validation.value.execution_note}`,
    before: deepClone(campaign),
    after: deepClone(updated)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, 'Campana programada localmente.', {
      campaign: campaignView(db, [updated], refreshAuthContext(auth, db).access)[0],
      metrics: campaignMetricsFor(db, updated)
    })
  };
}

export async function getCampaignMetricsV1(token, campaignId) {
  const auth = await authorize(token, 'campaigns.read', {
    context: 'campaign_metrics',
    entity: campaignId,
    message: 'Tu rol no puede consultar metricas de campanas.'
  });
  if (!auth.ok) {
    return auth;
  }
  const campaign = findCampaignById(auth.db, campaignId);
  if (!campaign) {
    return {
      ok: false,
      status: 404,
      error: 'campaign_not_found',
      message: 'La campana solicitada no existe.'
    };
  }
  if (!withinScope(auth.access, campaign.establishment_id)) {
    return denyPermission(auth, {
      permission: 'campaigns.read',
      entity: campaign.id,
      establishmentId: campaign.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no puede consultar metricas de ese establecimiento.',
      detail: `Fuera de alcance para ${campaign.establishment_id}`
    });
  }
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      campaign: campaignView(auth.db, [campaign], auth.access)[0],
      metrics: campaignMetricsFor(auth.db, campaign),
      identifiable_export: false
    }
  };
}

export async function exportCampaignMetricsV1(token, campaignId, body = {}) {
  const auth = await authorize(token, 'campaigns.export', {
    context: 'campaign_export',
    entity: campaignId,
    message: 'Tu rol no puede exportar metricas de campanas.'
  });
  if (!auth.ok) {
    return auth;
  }
  const campaign = findCampaignById(auth.db, campaignId);
  if (!campaign) {
    return {
      ok: false,
      status: 404,
      error: 'campaign_not_found',
      message: 'La campana solicitada no existe.'
    };
  }
  if (!withinScope(auth.access, campaign.establishment_id)) {
    return denyPermission(auth, {
      permission: 'campaigns.export',
      entity: campaign.id,
      establishmentId: campaign.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no puede exportar metricas de ese establecimiento.',
      detail: `Fuera de alcance para ${campaign.establishment_id}`
    });
  }
  const purpose = normalizeText(body.purpose);
  if (!purpose) {
    return validationError('La exportacion debe registrar finalidad sanitaria.', 'purpose');
  }
  if (body.identifiable === true) {
    return validationError('La exportacion identificable permanece bloqueada en modo local.', 'identifiable');
  }
  const metrics = campaignMetricsFor(auth.db, campaign);
  let db = appendAudit(auth.db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'campaign.export.aggregate',
    entity: campaign.id,
    result: 'pass',
    detail: `Exportacion agregada con finalidad ${purpose}`
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      export: {
        campaign_id: campaign.id,
        purpose,
        identifiable: false,
        generated_at: isoNow(),
        metrics
      }
    }
  };
}

export async function listSurveysV1(token) {
  const auth = await authorize(token, 'campaigns.read', {
    context: 'survey_list',
    entity: 'surveys',
    message: 'Tu rol no puede consultar encuestas.'
  });
  if (!auth.ok) {
    return auth;
  }
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      items: surveyView(auth.db, filterEntities(auth.db.surveys, auth.access, 'campaigns.read'))
    }
  };
}

export async function recordSurveyResponseV1(token, surveyId, body = {}) {
  const auth = await authorize(token, 'campaigns.manage', {
    context: 'survey_response_create',
    entity: surveyId,
    message: 'Tu rol no puede registrar respuestas de encuesta.'
  });
  if (!auth.ok) {
    return auth;
  }
  const survey = findSurveyById(auth.db, surveyId);
  if (!survey) {
    return {
      ok: false,
      status: 404,
      error: 'survey_not_found',
      message: 'La encuesta solicitada no existe.'
    };
  }
  const validation = validateSurveyResponsePayload(body);
  if (!validation.ok) {
    return validation;
  }
  const campaign = findCampaignById(auth.db, validation.value.campaign_id);
  const patient = findPatientById(auth.db, validation.value.patient_id);
  if (!campaign) {
    return {
      ok: false,
      status: 404,
      error: 'campaign_not_found',
      message: 'La campana asociada no existe.'
    };
  }
  if (!patient) {
    return {
      ok: false,
      status: 404,
      error: 'patient_not_found',
      message: 'El paciente solicitado no existe.'
    };
  }
  if (!withinScope(auth.access, campaign.establishment_id)) {
    return denyPermission(auth, {
      permission: 'campaigns.manage',
      entity: campaign.id,
      establishmentId: campaign.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no puede registrar respuestas para ese establecimiento.',
      detail: `Fuera de alcance para ${campaign.establishment_id}`
    });
  }
  if (campaign.survey_id !== survey.id) {
    return validationError('La campana no esta vinculada a esa encuesta.', 'campaign_id');
  }
  if (survey.status !== 'active') {
    return conflictError('La encuesta debe estar activa para registrar respuestas.', 'survey_id');
  }
  const responseRecord = {
    id: nextSequenceId(auth.db.survey_responses || [], 'SUR'),
    survey_id: survey.id,
    campaign_id: campaign.id,
    patient_id: patient.id,
    establishment_id: campaign.establishment_id,
    purpose: campaign.purpose,
    score: validation.value.score,
    comment: validation.value.comment,
    channel: validation.value.channel,
    created_at: isoNow(),
    created_by: auth.user.username
  };
  let db = {
    ...auth.db,
    survey_responses: [responseRecord, ...(auth.db.survey_responses || [])]
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'survey.response.create',
    entity: responseRecord.id,
    result: 'pass',
    detail: `Respuesta registrada para ${campaign.id} con puntaje ${responseRecord.score}`,
    after: deepClone(responseRecord)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 201,
    payload: mutationPayload(auth, db, 'Respuesta de encuesta registrada.', {
      survey_response: responseRecord,
      metrics: campaignMetricsFor(db, campaign)
    })
  };
}

export async function listSidraEventsV1(token, filters = {}) {
  const auth = await authorize(token, 'sidra.read', {
    context: 'sidra_list',
    entity: 'sidra',
    message: 'Tu rol no puede consultar la cola SIDRA simulada.'
  });
  if (!auth.ok) {
    return auth;
  }
  const establishmentId = normalizeNullableText(filters.establishment_id);
  if (establishmentId && !withinScope(auth.access, establishmentId)) {
    return denyPermission(auth, {
      permission: 'sidra.read',
      entity: 'sidra',
      establishmentId,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance sobre ese establecimiento.',
      detail: `Consulta SIDRA fuera de alcance en ${establishmentId}`
    });
  }
  const status = normalizeNullableText(filters.status);
  const items = sidraView(
    auth.db,
    filterEntities(auth.db.sidra, auth.access, 'sidra.read')
      .filter((item) => !establishmentId || item.establishment_id === establishmentId)
      .filter((item) => !status || item.status === status),
    auth.access,
    auth.runtime
  );
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      items
    }
  };
}

export async function createSidraEventV1(token, body = {}) {
  const auth = await authorize(token, 'sidra.manage', {
    context: 'sidra_create',
    entity: 'sidra',
    message: 'Tu rol no puede encolar eventos SIDRA.'
  });
  if (!auth.ok) {
    return auth;
  }
  const validation = validateSidraEventPayload(auth.db, body);
  if (!validation.ok) {
    return validation;
  }
  if (!withinScope(auth.access, validation.value.establishment_id)) {
    return denyPermission(auth, {
      permission: 'sidra.manage',
      entity: validation.value.entity_id,
      establishmentId: validation.value.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance para encolar ese evento.',
      detail: `Enqueue SIDRA fuera de alcance en ${validation.value.establishment_id}`
    });
  }
  let { db, event } = enqueueSidraEvent(auth.db, auth.runtime, auth.user.username, validation.value);
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'sidra.queue.enqueue',
    entity: event.id,
    result: 'pass',
    detail: `${event.type} para ${event.entity}:${event.entity_id}`,
    after: deepClone(event)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 201,
    payload: mutationPayload(auth, db, 'Evento SIDRA encolado.', {
      sidra_event: sidraEventView(db, event, buildAccessContext(auth.runtime, db, auth.user), auth.runtime)
    })
  };
}

export async function processSidraEventV1(token, eventId, body = {}) {
  const auth = await authorize(token, 'sidra.manage', {
    context: 'sidra_process',
    entity: eventId,
    message: 'Tu rol no puede procesar eventos SIDRA.'
  });
  if (!auth.ok) {
    return auth;
  }
  const event = findSidraEventById(auth.db, eventId);
  if (!event) {
    return {
      ok: false,
      status: 404,
      error: 'sidra_event_not_found',
      message: 'El evento SIDRA solicitado no existe.'
    };
  }
  if (!withinScope(auth.access, event.establishment_id)) {
    return denyPermission(auth, {
      permission: 'sidra.manage',
      entity: event.id,
      establishmentId: event.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance sobre ese evento SIDRA.',
      detail: `Proceso SIDRA fuera de alcance en ${event.establishment_id}`
    });
  }
  if (!sidraTransitionAllowed(event.status, 'process')) {
    return conflictError('El evento SIDRA no esta listo para procesarse.', 'sidra_event_id');
  }
  const validation = validateSidraProcessingPayload({
    result: body.result || event.simulation_default_result || 'acknowledged',
    detail: body.detail || `Procesamiento ${event.type} en SIDRA simulado`,
    error_code: body.error_code
  });
  if (!validation.ok) {
    return validation;
  }
  let { db, event: updated } = applySidraProcessResult(
    auth.runtime,
    auth.db,
    event,
    auth.user.username,
    auth.user.role,
    validation.value.result,
    validation.value.detail,
    validation.value.error_code
  );
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'sidra.queue.process',
    entity: updated.id,
    result: updated.status === 'acknowledged' ? 'pass' : 'warn',
    detail: `${validation.value.result}: ${validation.value.detail}`,
    before: deepClone(event),
    after: deepClone(updated)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, 'Evento SIDRA procesado.', {
      sidra_event: sidraEventView(db, updated, buildAccessContext(auth.runtime, db, auth.user), auth.runtime)
    })
  };
}

export async function retrySidraEventV1(token, eventId, body = {}) {
  const auth = await authorize(token, 'sidra.manage', {
    context: 'sidra_retry',
    entity: eventId,
    message: 'Tu rol no puede reintentar eventos SIDRA.'
  });
  if (!auth.ok) {
    return auth;
  }
  const event = findSidraEventById(auth.db, eventId);
  if (!event) {
    return {
      ok: false,
      status: 404,
      error: 'sidra_event_not_found',
      message: 'El evento SIDRA solicitado no existe.'
    };
  }
  if (!withinScope(auth.access, event.establishment_id)) {
    return denyPermission(auth, {
      permission: 'sidra.manage',
      entity: event.id,
      establishmentId: event.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance sobre ese evento SIDRA.',
      detail: `Retry SIDRA fuera de alcance en ${event.establishment_id}`
    });
  }
  if (!sidraTransitionAllowed(event.status, 'retry')) {
    return conflictError('El evento SIDRA no permite reintento en su estado actual.', 'sidra_event_id');
  }
  const maxRetries = Number(event.max_retries || sidraRetryLimit(auth.runtime));
  if (Number(event.retries || 0) >= maxRetries) {
    return conflictError('El evento SIDRA ya alcanzo el maximo de reintentos configurado.', 'sidra_event_id');
  }
  const updated = {
    ...event,
    status: 'retry_pending',
    next_retry_at: new Date(Date.now() + sidraRetryDelayMinutes(auth.runtime) * 60 * 1000).toISOString(),
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    sidra: (auth.db.sidra || []).map((item) => item.id === event.id ? updated : item)
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'sidra.queue.retry_requested',
    entity: updated.id,
    result: 'pass',
    detail: normalizeText(body.detail) || 'Reintento manual solicitado.',
    before: deepClone(event),
    after: deepClone(updated)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, 'Evento SIDRA marcado para reintento.', {
      sidra_event: sidraEventView(db, updated, buildAccessContext(auth.runtime, db, auth.user), auth.runtime)
    })
  };
}

export async function resolveSidraDiscrepancyV1(token, eventId, body = {}) {
  const auth = await authorize(token, 'sidra.manage', {
    context: 'sidra_discrepancy_resolve',
    entity: eventId,
    message: 'Tu rol no puede resolver discrepancias SIDRA.'
  });
  if (!auth.ok) {
    return auth;
  }
  const event = findSidraEventById(auth.db, eventId);
  if (!event) {
    return {
      ok: false,
      status: 404,
      error: 'sidra_event_not_found',
      message: 'El evento SIDRA solicitado no existe.'
    };
  }
  if (!withinScope(auth.access, event.establishment_id)) {
    return denyPermission(auth, {
      permission: 'sidra.manage',
      entity: event.id,
      establishmentId: event.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance sobre ese evento SIDRA.',
      detail: `Resolucion de discrepancia fuera de alcance en ${event.establishment_id}`
    });
  }
  if (!sidraTransitionAllowed(event.status, 'resolve_discrepancy')) {
    return conflictError('El evento SIDRA no esta en discrepancia.', 'sidra_event_id');
  }
  const resolutionNote = normalizeText(body.resolution_note || body.detail);
  if (!resolutionNote) {
    return validationError('Debes registrar un criterio de resolucion.', 'resolution_note');
  }
  const updated = {
    ...event,
    status: 'acknowledged',
    discrepancy_note: resolutionNote,
    acknowledged_at: isoNow(),
    resolved_at: isoNow(),
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    sidra: (auth.db.sidra || []).map((item) => item.id === event.id ? updated : item)
  };
  db = appendSidraAttempt(db, {
    sidra_event_id: event.id,
    attempt_number: Number(event.retries || 0),
    status_before: event.status,
    status_after: updated.status,
    result: 'acknowledged',
    detail: resolutionNote,
    actor: auth.user.username,
    role: auth.user.role
  });
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'sidra.queue.discrepancy_resolved',
    entity: updated.id,
    result: 'pass',
    detail: resolutionNote,
    before: deepClone(event),
    after: deepClone(updated)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, 'Discrepancia SIDRA resuelta.', {
      sidra_event: sidraEventView(db, updated, buildAccessContext(auth.runtime, db, auth.user), auth.runtime)
    })
  };
}

export async function listPatients(token) {
  const auth = await authorize(token, 'patients.read', {
    context: 'patients_list',
    entity: 'patients',
    message: 'Tu rol no puede consultar pacientes.'
  });
  if (!auth.ok) {
    return auth;
  }
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      items: patientView(auth.db, filterEntities(auth.db.patients, auth.access, 'patients.read'), auth.access),
      scope: auth.access.allowedEstablishmentIds
    }
  };
}

export async function listAudit(token, filters = {}) {
  const auth = await authorize(token, 'audit.view', {
    context: 'audit_list',
    entity: 'audit',
    message: 'Tu rol no puede consultar la auditoria.'
  });
  if (!auth.ok) {
    return auth;
  }
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      items: (auth.db.audit || [])
        .filter((item) => auditMatchesFilters(item, filters))
        .slice(0, Math.min(Number(filters.limit || 120), 250))
    }
  };
}

export async function listMonthlyReportsV1(token, filters = {}) {
  const auth = await authorize(token, 'reports.read', {
    context: 'reports_list',
    entity: 'monthly_reports',
    message: 'Tu rol no puede consultar reportes mensuales.'
  });
  if (!auth.ok) {
    return auth;
  }
  const normalized = reportFiltersSummary(filters);
  if (normalized.establishment_id && !withinScope(auth.access, normalized.establishment_id)) {
    return denyPermission(auth, {
      permission: 'reports.read',
      entity: normalized.establishment_id,
      establishmentId: normalized.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no puede consultar reportes de ese establecimiento.',
      detail: `Reporte fuera de alcance en ${normalized.establishment_id}`
    });
  }
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      items: (auth.db.monthly_reports || [])
        .filter((item) => monthlyReportMatches(item, auth.access, normalized))
        .map(monthlyReportView)
        .slice(0, 60)
    }
  };
}

export async function createMonthlyReportV1(token, body = {}) {
  const auth = await authorize(token, 'reports.read', {
    context: 'report_create',
    entity: 'monthly_reports',
    message: 'Tu rol no puede generar reportes mensuales.'
  });
  if (!auth.ok) {
    return auth;
  }
  const filters = reportFiltersSummary(body);
  if (filters.establishment_id && !withinScope(auth.access, filters.establishment_id)) {
    return denyPermission(auth, {
      permission: 'reports.read',
      entity: filters.establishment_id,
      establishmentId: filters.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no puede generar reportes para ese establecimiento.',
      detail: `Reporte fuera de alcance en ${filters.establishment_id}`
    });
  }
  if (body.identifiable === true) {
    return validationError('La reportabilidad identificable permanece bloqueada en modo local.', 'identifiable');
  }
  const report = buildMonthlyReport(auth.runtime, auth.db, auth.access, filters);
  let db = {
    ...auth.db,
    monthly_reports: [report, ...(auth.db.monthly_reports || [])]
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'report.monthly.generate',
    entity: report.id,
    result: 'pass',
    detail: `Reporte ${report.period} generado con filtros ${JSON.stringify(filters)}`,
    after: deepClone(report)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 201,
    payload: mutationPayload(auth, db, 'Reporte mensual generado.', {
      report: monthlyReportView(report)
    })
  };
}

export async function exportMonthlyReportV1(token, body = {}) {
  const auth = await authorize(token, 'reports.export', {
    context: 'report_export',
    entity: 'monthly_reports',
    message: 'Tu rol no puede exportar reportes agregados.'
  });
  if (!auth.ok) {
    return auth;
  }
  const filters = reportFiltersSummary(body);
  if (filters.establishment_id && !withinScope(auth.access, filters.establishment_id)) {
    return denyPermission(auth, {
      permission: 'reports.export',
      entity: filters.establishment_id,
      establishmentId: filters.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no puede exportar reportes de ese establecimiento.',
      detail: `Exportacion fuera de alcance en ${filters.establishment_id}`
    });
  }
  const purpose = normalizeText(body.purpose);
  if (!purpose) {
    return validationError('La exportacion del reporte debe registrar finalidad.', 'purpose');
  }
  if (body.identifiable === true) {
    return validationError('La exportacion identificable permanece bloqueada en modo local.', 'identifiable');
  }
  const report = buildMonthlyReport(auth.runtime, auth.db, auth.access, filters);
  let db = appendAudit(auth.db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'report.monthly.export.aggregate',
    entity: report.id,
    result: 'pass',
    detail: `Exportacion agregada ${report.period} con finalidad ${purpose}`
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      export: {
        report_id: report.id,
        purpose,
        identifiable: false,
        generated_at: isoNow(),
        report: monthlyReportView(report)
      }
    }
  };
}

export async function createBackupV1(token, body = {}) {
  const auth = await authorize(token, 'backup.manage', {
    context: 'backup_create',
    entity: 'backups',
    message: 'Tu rol no puede generar respaldos locales.'
  });
  if (!auth.ok) {
    return auth;
  }
  const label = normalizeText(body.label) || `backup-${isoMonth()}-${slugify(auth.user.username)}`;
  const note = normalizeNullableText(body.note);
  const backupId = `${isoNow().replace(/[:.]/g, '-')}-${slugify(label)}`;
  const filename = `${backupId}.json`;
  const fileUrl = new URL(filename, BACKUPS_DIR_URL);
  const snapshot = {
    backup_id: backupId,
    created_at: isoNow(),
    created_by: auth.user.username,
    version: auth.runtime.version,
    phase: auth.runtime.phase,
    label,
    note,
    db: auth.db
  };
  await ensureBackupsDir();
  await writeJson(fileUrl, snapshot);
  const backupRecord = {
    id: backupId,
    label,
    note,
    file: `data/backups/${filename}`,
    created_at: snapshot.created_at,
    created_by: auth.user.username,
    version: auth.runtime.version,
    phase: auth.runtime.phase
  };
  let db = {
    ...auth.db,
    backups_catalog: [backupRecord, ...(auth.db.backups_catalog || []).filter((item) => item.id !== backupId)].slice(0, 40)
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'continuity.backup.create',
    entity: backupId,
    result: 'pass',
    detail: `Respaldo local ${label} generado`
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 201,
    payload: mutationPayload(auth, db, 'Respaldo local generado.', {
      backup: backupRecord
    })
  };
}

export async function listBackupsV1(token) {
  const auth = await authorize(token, 'backup.manage', {
    context: 'backup_list',
    entity: 'backups',
    message: 'Tu rol no puede consultar respaldos locales.'
  });
  if (!auth.ok) {
    return auth;
  }
  const files = await listBackupFiles();
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      items: (auth.db.backups_catalog || []).map((item) => ({
        ...item,
        exists: files.includes(item.file.split('/').pop())
      }))
    }
  };
}

export async function restoreBackupV1(token, body = {}) {
  const auth = await authorize(token, 'backup.manage', {
    context: 'backup_restore',
    entity: 'backups',
    message: 'Tu rol no puede restaurar respaldos locales.'
  });
  if (!auth.ok) {
    return auth;
  }
  const backupId = normalizeText(body.backup_id);
  if (!backupId) {
    return validationError('Debes indicar el respaldo a restaurar.', 'backup_id');
  }
  const record = (auth.db.backups_catalog || []).find((item) => item.id === backupId);
  if (!record) {
    return {
      ok: false,
      status: 404,
      error: 'backup_not_found',
      message: 'El respaldo solicitado no existe.'
    };
  }
  const snapshot = JSON.parse(await readFile(new URL(record.file.replace('data/backups/', ''), BACKUPS_DIR_URL), 'utf8'));
  const restoredDb = appendAudit({
    ...snapshot.db,
    backups_catalog: auth.db.backups_catalog || snapshot.db.backups_catalog || []
  }, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'continuity.backup.restore',
    entity: backupId,
    result: 'pass',
    detail: `Restore local ejecutado desde ${record.label}`
  });
  await saveDatabase(restoredDb);
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      message: 'Respaldo restaurado localmente.',
      restored_backup_id: backupId
    }
  };
}

export async function listPatientsV1(token) {
  return listPatients(token);
}

export async function getPatientV1(token, patientId) {
  const auth = await authorize(token, 'patients.read', {
    context: 'patient_detail',
    entity: patientId,
    message: 'Tu rol no puede consultar pacientes.'
  });
  if (!auth.ok) {
    return auth;
  }
  const patient = findPatientById(auth.db, patientId);
  const denied = patientInScopeOrDenied(auth, patient, 'patients.read', 'Tu rol no tiene alcance sobre el paciente solicitado.');
  if (denied) {
    return denied;
  }
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      item: patientView(auth.db, [patient], auth.access)[0]
    }
  };
}

export async function createPatientV1(token, body) {
  const auth = await authorize(token, 'patients.write', {
    context: 'patient_create',
    entity: 'patients',
    message: 'Tu rol no puede crear pacientes.'
  });
  if (!auth.ok) {
    return auth;
  }
  const validation = validatePatientPayload(auth.db, body);
  if (!validation.ok) {
    return validation;
  }
  if (!withinScope(auth.access, validation.value.establishment_id)) {
    return denyPermission(auth, {
      permission: 'patients.write',
      entity: 'patients',
      establishmentId: validation.value.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance para crear pacientes en ese establecimiento.',
      detail: `Creacion de paciente fuera de alcance en ${validation.value.establishment_id}`
    });
  }
  const timestamp = isoNow();
  const patient = {
    id: nextSequenceId(auth.db.patients, 'P'),
    ...validation.value,
    contactable: false,
    created_at: timestamp,
    updated_at: timestamp,
    created_by: auth.user.username,
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    patients: [patient, ...(auth.db.patients || [])]
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'patient.create',
    entity: patient.id,
    result: 'pass',
    detail: `Paciente creado en ${patient.establishment_id}`,
    after: deepClone(patient)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 201,
    payload: mutationPayload(auth, db, 'Paciente creado correctamente.', {
      patient: patientView(db, [patient], buildAccessContext(auth.runtime, db, auth.user))[0]
    })
  };
}

export async function updatePatientV1(token, patientId, body) {
  const auth = await authorize(token, 'patients.write', {
    context: 'patient_update',
    entity: patientId,
    message: 'Tu rol no puede editar pacientes.'
  });
  if (!auth.ok) {
    return auth;
  }
  const current = findPatientById(auth.db, patientId);
  const denied = patientInScopeOrDenied(auth, current, 'patients.write', 'Tu rol no tiene alcance sobre el paciente solicitado.');
  if (denied) {
    return denied;
  }
  const validation = validatePatientPayload(auth.db, body, current);
  if (!validation.ok) {
    return validation;
  }
  if (!withinScope(auth.access, validation.value.establishment_id)) {
    return denyPermission(auth, {
      permission: 'patients.write',
      entity: patientId,
      establishmentId: validation.value.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no puede mover el paciente a ese establecimiento.',
      detail: `Actualizacion de paciente fuera de alcance en ${validation.value.establishment_id}`
    });
  }
  const updated = {
    ...current,
    ...validation.value,
    contactable: current.contactable,
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  if (validation.value.status !== current.status && validation.value.status !== 'activo') {
    updated.closed_at = isoNow();
    updated.closure_reason = validation.value.closure_reason;
  }
  let db = {
    ...auth.db,
    patients: (auth.db.patients || []).map((item) => item.id === patientId ? updated : item)
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: validation.value.status !== current.status && validation.value.status !== 'activo' ? 'patient.close' : 'patient.update',
    entity: patientId,
    result: 'pass',
    detail: validation.value.status !== current.status && validation.value.status !== 'activo'
      ? `Paciente cerrado logicamente con estado ${validation.value.status}`
      : 'Paciente actualizado',
    before: deepClone(current),
    after: deepClone(updated)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, 'Paciente actualizado correctamente.', {
      patient: patientView(db, [updated], buildAccessContext(auth.runtime, db, auth.user))[0]
    })
  };
}

export async function listPatientContactsV1(token, patientId) {
  const auth = await authorize(token, 'patients.read', {
    context: 'patient_contacts_list',
    entity: patientId,
    message: 'Tu rol no puede consultar contactos de pacientes.'
  });
  if (!auth.ok) {
    return auth;
  }
  const patient = findPatientById(auth.db, patientId);
  const denied = patientInScopeOrDenied(auth, patient, 'patients.read', 'Tu rol no tiene alcance sobre el paciente solicitado.');
  if (denied) {
    return denied;
  }
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      patient_id: patientId,
      items: contactsForPatient(auth.db, patientId).map(contactView)
    }
  };
}

export async function createPatientContactV1(token, patientId, body) {
  const auth = await authorize(token, 'patients.write', {
    context: 'patient_contact_create',
    entity: patientId,
    message: 'Tu rol no puede registrar contactos.'
  });
  if (!auth.ok) {
    return auth;
  }
  const patient = findPatientById(auth.db, patientId);
  const denied = patientInScopeOrDenied(auth, patient, 'patients.write', 'Tu rol no tiene alcance sobre el paciente solicitado.');
  if (denied) {
    return denied;
  }
  const validation = validateContactPayload(body);
  if (!validation.ok) {
    return validation;
  }
  const timestamp = isoNow();
  const contact = {
    id: nextSequenceId(auth.db.patient_contacts, 'CNT'),
    patient_id: patientId,
    ...validation.value,
    created_at: timestamp,
    updated_at: timestamp,
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    patient_contacts: [contact, ...(auth.db.patient_contacts || [])],
    patients: (auth.db.patients || []).map((item) => item.id === patientId ? {
      ...item,
      contactable: true,
      updated_at: timestamp,
      updated_by: auth.user.username
    } : item)
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'patient.contact.create',
    entity: contact.id,
    result: 'pass',
    detail: `Contacto creado para ${patientId}`,
    after: deepClone(contact)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 201,
    payload: mutationPayload(auth, db, 'Contacto registrado correctamente.', {
      contact: contactView(contact)
    })
  };
}

export async function updatePatientContactV1(token, patientId, contactId, body) {
  const auth = await authorize(token, 'patients.write', {
    context: 'patient_contact_update',
    entity: contactId,
    message: 'Tu rol no puede editar contactos.'
  });
  if (!auth.ok) {
    return auth;
  }
  const patient = findPatientById(auth.db, patientId);
  const denied = patientInScopeOrDenied(auth, patient, 'patients.write', 'Tu rol no tiene alcance sobre el paciente solicitado.');
  if (denied) {
    return denied;
  }
  const current = contactsForPatient(auth.db, patientId).find((item) => item.id === contactId);
  if (!current) {
    return {
      ok: false,
      status: 404,
      error: 'contact_not_found',
      message: 'El contacto solicitado no existe.'
    };
  }
  const validation = validateContactPayload(body, current);
  if (!validation.ok) {
    return validation;
  }
  const updated = {
    ...current,
    ...validation.value,
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    patient_contacts: (auth.db.patient_contacts || []).map((item) => item.id === contactId ? updated : item)
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'patient.contact.update',
    entity: contactId,
    result: 'pass',
    detail: `Contacto actualizado para ${patientId}`,
    before: deepClone(current),
    after: deepClone(updated)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, 'Contacto actualizado correctamente.', {
      contact: contactView(updated)
    })
  };
}

export async function createPatientRepresentativeV1(token, patientId, body) {
  const auth = await authorize(token, 'patients.write', {
    context: 'patient_representative_create',
    entity: patientId,
    message: 'Tu rol no puede registrar representantes.'
  });
  if (!auth.ok) {
    return auth;
  }
  const patient = findPatientById(auth.db, patientId);
  const denied = patientInScopeOrDenied(auth, patient, 'patients.write', 'Tu rol no tiene alcance sobre el paciente solicitado.');
  if (denied) {
    return denied;
  }
  const validation = validateRepresentativePayload(body);
  if (!validation.ok) {
    return validation;
  }
  const timestamp = isoNow();
  const representative = {
    id: nextSequenceId(auth.db.representatives, 'REP'),
    patient_id: patientId,
    ...validation.value,
    created_at: timestamp,
    updated_at: timestamp,
    created_by: auth.user.username,
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    representatives: [representative, ...(auth.db.representatives || [])]
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'patient.representative.create',
    entity: representative.id,
    result: 'pass',
    detail: `Representante creado para ${patientId}`,
    after: deepClone(representative)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 201,
    payload: mutationPayload(auth, db, 'Representante registrado correctamente.', {
      representative: representativeView(representative)
    })
  };
}

export async function updatePatientRepresentativeV1(token, patientId, representativeId, body) {
  const auth = await authorize(token, 'patients.write', {
    context: 'patient_representative_update',
    entity: representativeId,
    message: 'Tu rol no puede editar representantes.'
  });
  if (!auth.ok) {
    return auth;
  }
  const patient = findPatientById(auth.db, patientId);
  const denied = patientInScopeOrDenied(auth, patient, 'patients.write', 'Tu rol no tiene alcance sobre el paciente solicitado.');
  if (denied) {
    return denied;
  }
  const current = representativesForPatient(auth.db, patientId).find((item) => item.id === representativeId);
  if (!current) {
    return {
      ok: false,
      status: 404,
      error: 'representative_not_found',
      message: 'El representante solicitado no existe.'
    };
  }
  const validation = validateRepresentativePayload(body, current);
  if (!validation.ok) {
    return validation;
  }
  const updated = {
    ...current,
    ...validation.value,
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    representatives: (auth.db.representatives || []).map((item) => item.id === representativeId ? updated : item)
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'patient.representative.update',
    entity: representativeId,
    result: 'pass',
    detail: `Representante actualizado para ${patientId}`,
    before: deepClone(current),
    after: deepClone(updated)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, 'Representante actualizado correctamente.', {
      representative: representativeView(updated)
    })
  };
}

export async function updatePatientPreferencesV1(token, patientId, body) {
  const auth = await authorize(token, 'patients.write', {
    context: 'patient_preferences_update',
    entity: patientId,
    message: 'Tu rol no puede actualizar preferencias.'
  });
  if (!auth.ok) {
    return auth;
  }
  const patient = findPatientById(auth.db, patientId);
  const denied = patientInScopeOrDenied(auth, patient, 'patients.write', 'Tu rol no tiene alcance sobre el paciente solicitado.');
  if (denied) {
    return denied;
  }
  const current = preferencesForPatient(auth.db, patientId);
  const validation = validatePreferencePayload(auth.db, patientId, body, current);
  if (!validation.ok) {
    return validation;
  }
  const updated = {
    ...(current || {}),
    ...validation.value,
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    contact_preferences: current
      ? (auth.db.contact_preferences || []).map((item) => item.patient_id === patientId ? updated : item)
      : [updated, ...(auth.db.contact_preferences || [])]
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'patient.preference.update',
    entity: patientId,
    result: 'pass',
    detail: `Preferencias actualizadas para ${patientId}`,
    before: current ? deepClone(current) : null,
    after: deepClone(updated)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, 'Preferencias actualizadas correctamente.', {
      preferences: preferenceView(updated)
    })
  };
}

export async function listPatientConsentsV1(token, patientId) {
  const auth = await authorize(token, 'patients.read', {
    context: 'patient_consents_list',
    entity: patientId,
    message: 'Tu rol no puede consultar consentimientos.'
  });
  if (!auth.ok) {
    return auth;
  }
  const patient = findPatientById(auth.db, patientId);
  const denied = patientInScopeOrDenied(auth, patient, 'patients.read', 'Tu rol no tiene alcance sobre el paciente solicitado.');
  if (denied) {
    return denied;
  }
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      patient_id: patientId,
      items: consentsForPatient(auth.db, patientId).map(consentView)
    }
  };
}

export async function createPatientConsentV1(token, patientId, body) {
  const auth = await authorize(token, 'patients.write', {
    context: 'patient_consent_create',
    entity: patientId,
    message: 'Tu rol no puede registrar consentimientos.'
  });
  if (!auth.ok) {
    return auth;
  }
  const patient = findPatientById(auth.db, patientId);
  const denied = patientInScopeOrDenied(auth, patient, 'patients.write', 'Tu rol no tiene alcance sobre el paciente solicitado.');
  if (denied) {
    return denied;
  }
  const validation = validateConsentPayload(body);
  if (!validation.ok) {
    return validation;
  }
  const timestamp = isoNow();
  const consent = {
    id: nextSequenceId(auth.db.consents, 'CON'),
    patient_id: patientId,
    ...validation.value,
    granted_at: validation.value.status === 'vigente' ? timestamp : null,
    revoked_at: validation.value.status === 'revocado' ? timestamp : null,
    updated_at: timestamp,
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    consents: [consent, ...(auth.db.consents || [])]
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'patient.consent.create',
    entity: consent.id,
    result: 'pass',
    detail: `Consentimiento registrado para ${patientId}`,
    after: deepClone(consent)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 201,
    payload: mutationPayload(auth, db, 'Consentimiento registrado correctamente.', {
      consent: consentView(consent)
    })
  };
}

export async function updatePatientConsentV1(token, patientId, consentId, body) {
  const auth = await authorize(token, 'patients.write', {
    context: 'patient_consent_update',
    entity: consentId,
    message: 'Tu rol no puede editar consentimientos.'
  });
  if (!auth.ok) {
    return auth;
  }
  const patient = findPatientById(auth.db, patientId);
  const denied = patientInScopeOrDenied(auth, patient, 'patients.write', 'Tu rol no tiene alcance sobre el paciente solicitado.');
  if (denied) {
    return denied;
  }
  const current = consentsForPatient(auth.db, patientId).find((item) => item.id === consentId);
  if (!current) {
    return {
      ok: false,
      status: 404,
      error: 'consent_not_found',
      message: 'El consentimiento solicitado no existe.'
    };
  }
  const validation = validateConsentPayload(body, current);
  if (!validation.ok) {
    return validation;
  }
  const updated = {
    ...current,
    ...validation.value,
    granted_at: current.granted_at || (validation.value.status === 'vigente' ? isoNow() : null),
    revoked_at: validation.value.status === 'revocado' ? (body.revoked_at || isoNow()) : null,
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    consents: (auth.db.consents || []).map((item) => item.id === consentId ? updated : item)
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'patient.consent.update',
    entity: consentId,
    result: 'pass',
    detail: `Consentimiento actualizado para ${patientId}`,
    before: deepClone(current),
    after: deepClone(updated)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, 'Consentimiento actualizado correctamente.', {
      consent: consentView(updated)
    })
  };
}

export async function listProfessionalsV1(token) {
  const auth = await authorize(token, 'agenda.read', {
    context: 'professionals_list',
    entity: 'professionals',
    message: 'Tu rol no puede consultar profesionales.'
  });
  if (!auth.ok) {
    return auth;
  }
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      items: professionalView(auth.db, filterEntities(auth.db.professionals, auth.access, 'agenda.read'))
    }
  };
}

export async function createProfessionalV1(token, body) {
  const auth = await authorize(token, 'agenda.write', {
    context: 'professional_create',
    entity: 'professionals',
    message: 'Tu rol no puede crear profesionales.'
  });
  if (!auth.ok) {
    return auth;
  }
  const validation = validateProfessionalPayload(auth.db, body);
  if (!validation.ok) {
    return validation;
  }
  if (!withinScope(auth.access, validation.value.establishment_id)) {
    return denyPermission(auth, {
      permission: 'agenda.write',
      entity: 'professionals',
      establishmentId: validation.value.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance para crear profesionales en ese establecimiento.',
      detail: `Alta de profesional fuera de alcance en ${validation.value.establishment_id}`
    });
  }
  const professional = {
    id: nextSequenceId(auth.db.professionals || [], 'PR'),
    ...validation.value,
    created_at: isoNow(),
    updated_at: isoNow(),
    created_by: auth.user.username,
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    professionals: [professional, ...(auth.db.professionals || [])]
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'agenda.professional.create',
    entity: professional.id,
    result: 'pass',
    detail: `Profesional creado en ${professional.establishment_id}`,
    after: deepClone(professional)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 201,
    payload: mutationPayload(auth, db, 'Profesional creado correctamente.', {
      professional: professionalView(db, [professional])[0]
    })
  };
}

export async function updateProfessionalV1(token, professionalId, body) {
  const auth = await authorize(token, 'agenda.write', {
    context: 'professional_update',
    entity: professionalId,
    message: 'Tu rol no puede editar profesionales.'
  });
  if (!auth.ok) {
    return auth;
  }
  const current = findProfessionalById(auth.db, professionalId);
  if (!current) {
    return {
      ok: false,
      status: 404,
      error: 'professional_not_found',
      message: 'El profesional solicitado no existe.'
    };
  }
  const validation = validateProfessionalPayload(auth.db, body, current);
  if (!validation.ok) {
    return validation;
  }
  if (!withinScope(auth.access, validation.value.establishment_id)) {
    return denyPermission(auth, {
      permission: 'agenda.write',
      entity: professionalId,
      establishmentId: validation.value.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance sobre ese profesional.',
      detail: `Edicion de profesional fuera de alcance en ${validation.value.establishment_id}`
    });
  }
  const updated = {
    ...current,
    ...validation.value,
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    professionals: (auth.db.professionals || []).map((item) => item.id === professionalId ? updated : item)
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'agenda.professional.update',
    entity: professionalId,
    result: 'pass',
    detail: 'Profesional actualizado',
    before: deepClone(current),
    after: deepClone(updated)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, 'Profesional actualizado correctamente.', {
      professional: professionalView(db, [updated])[0]
    })
  };
}

export async function listServicesV1(token) {
  const auth = await authorize(token, 'agenda.read', {
    context: 'services_list',
    entity: 'services',
    message: 'Tu rol no puede consultar prestaciones.'
  });
  if (!auth.ok) {
    return auth;
  }
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      items: serviceView(auth.db, filterEntities(auth.db.services, auth.access, 'agenda.read'))
    }
  };
}

export async function createServiceV1(token, body) {
  const auth = await authorize(token, 'agenda.write', {
    context: 'service_create',
    entity: 'services',
    message: 'Tu rol no puede crear prestaciones.'
  });
  if (!auth.ok) {
    return auth;
  }
  const validation = validateServicePayload(auth.db, body);
  if (!validation.ok) {
    return validation;
  }
  if (!withinScope(auth.access, validation.value.establishment_id)) {
    return denyPermission(auth, {
      permission: 'agenda.write',
      entity: 'services',
      establishmentId: validation.value.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance para crear prestaciones en ese establecimiento.',
      detail: `Alta de prestacion fuera de alcance en ${validation.value.establishment_id}`
    });
  }
  const service = {
    id: nextSequenceId(auth.db.services || [], 'SV'),
    ...validation.value,
    created_at: isoNow(),
    updated_at: isoNow(),
    created_by: auth.user.username,
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    services: [service, ...(auth.db.services || [])]
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'agenda.service.create',
    entity: service.id,
    result: 'pass',
    detail: `Prestacion creada en ${service.establishment_id}`,
    after: deepClone(service)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 201,
    payload: mutationPayload(auth, db, 'Prestacion creada correctamente.', {
      service: serviceView(db, [service])[0]
    })
  };
}

export async function updateServiceV1(token, serviceId, body) {
  const auth = await authorize(token, 'agenda.write', {
    context: 'service_update',
    entity: serviceId,
    message: 'Tu rol no puede editar prestaciones.'
  });
  if (!auth.ok) {
    return auth;
  }
  const current = findServiceById(auth.db, serviceId);
  if (!current) {
    return {
      ok: false,
      status: 404,
      error: 'service_not_found',
      message: 'La prestacion solicitada no existe.'
    };
  }
  const validation = validateServicePayload(auth.db, body, current);
  if (!validation.ok) {
    return validation;
  }
  if (!withinScope(auth.access, validation.value.establishment_id)) {
    return denyPermission(auth, {
      permission: 'agenda.write',
      entity: serviceId,
      establishmentId: validation.value.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance sobre esa prestacion.',
      detail: `Edicion de prestacion fuera de alcance en ${validation.value.establishment_id}`
    });
  }
  const updated = {
    ...current,
    ...validation.value,
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    services: (auth.db.services || []).map((item) => item.id === serviceId ? updated : item)
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'agenda.service.update',
    entity: serviceId,
    result: 'pass',
    detail: 'Prestacion actualizada',
    before: deepClone(current),
    after: deepClone(updated)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, 'Prestacion actualizada correctamente.', {
      service: serviceView(db, [updated])[0]
    })
  };
}

export async function listAgendasV1(token) {
  const auth = await authorize(token, 'agenda.read', {
    context: 'agendas_list',
    entity: 'agendas',
    message: 'Tu rol no puede consultar agendas.'
  });
  if (!auth.ok) {
    return auth;
  }
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      items: agendaView(auth.db, filterEntities(auth.db.agendas, auth.access, 'agenda.read'))
    }
  };
}

export async function createAgendaV1(token, body) {
  const auth = await authorize(token, 'agenda.write', {
    context: 'agenda_create',
    entity: 'agendas',
    message: 'Tu rol no puede crear agendas.'
  });
  if (!auth.ok) {
    return auth;
  }
  const validation = validateAgendaPayload(auth.db, body);
  if (!validation.ok) {
    return validation;
  }
  if (!withinScope(auth.access, validation.value.establishment_id)) {
    return denyPermission(auth, {
      permission: 'agenda.write',
      entity: 'agendas',
      establishmentId: validation.value.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance para crear agendas en ese establecimiento.',
      detail: `Alta de agenda fuera de alcance en ${validation.value.establishment_id}`
    });
  }
  const agenda = {
    id: nextSequenceId(auth.db.agendas || [], 'AG'),
    ...validation.value,
    created_at: isoNow(),
    updated_at: isoNow(),
    created_by: auth.user.username,
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    agendas: [agenda, ...(auth.db.agendas || [])]
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'agenda.config.create',
    entity: agenda.id,
    result: 'pass',
    detail: `Agenda creada en ${agenda.establishment_id}`,
    after: deepClone(agenda)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 201,
    payload: mutationPayload(auth, db, 'Agenda creada correctamente.', {
      agenda: agendaView(db, [agenda])[0]
    })
  };
}

export async function updateAgendaV1(token, agendaId, body) {
  const auth = await authorize(token, 'agenda.write', {
    context: 'agenda_update',
    entity: agendaId,
    message: 'Tu rol no puede editar agendas.'
  });
  if (!auth.ok) {
    return auth;
  }
  const current = findAgendaById(auth.db, agendaId);
  if (!current) {
    return {
      ok: false,
      status: 404,
      error: 'agenda_not_found',
      message: 'La agenda solicitada no existe.'
    };
  }
  const validation = validateAgendaPayload(auth.db, body, current);
  if (!validation.ok) {
    return validation;
  }
  if (!withinScope(auth.access, validation.value.establishment_id)) {
    return denyPermission(auth, {
      permission: 'agenda.write',
      entity: agendaId,
      establishmentId: validation.value.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance sobre esa agenda.',
      detail: `Edicion de agenda fuera de alcance en ${validation.value.establishment_id}`
    });
  }
  const updated = {
    ...current,
    ...validation.value,
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    agendas: (auth.db.agendas || []).map((item) => item.id === agendaId ? updated : item)
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'agenda.config.update',
    entity: agendaId,
    result: 'pass',
    detail: 'Agenda actualizada',
    before: deepClone(current),
    after: deepClone(updated)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, 'Agenda actualizada correctamente.', {
      agenda: agendaView(db, [updated])[0]
    })
  };
}

export async function listSlotsV1(token) {
  const auth = await authorize(token, 'agenda.read', {
    context: 'slots_list',
    entity: 'slots',
    message: 'Tu rol no puede consultar cupos.'
  });
  if (!auth.ok) {
    return auth;
  }
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      items: slotView(auth.db, filterEntities(auth.db.slots, auth.access, 'agenda.read'), auth.access)
    }
  };
}

export async function createSlotV1(token, body) {
  const auth = await authorize(token, 'agenda.write', {
    context: 'slot_create',
    entity: 'slots',
    message: 'Tu rol no puede crear cupos.'
  });
  if (!auth.ok) {
    return auth;
  }
  const validation = validateSlotPayload(auth.db, body);
  if (!validation.ok) {
    return validation;
  }
  if (!withinScope(auth.access, validation.value.establishment_id)) {
    return denyPermission(auth, {
      permission: 'agenda.write',
      entity: 'slots',
      establishmentId: validation.value.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance para crear cupos en ese establecimiento.',
      detail: `Alta de cupo fuera de alcance en ${validation.value.establishment_id}`
    });
  }
  const slot = {
    id: nextSequenceId(auth.db.slots || [], 'S'),
    ...validation.value,
    created_at: isoNow(),
    updated_at: isoNow(),
    created_by: auth.user.username,
    updated_by: auth.user.username,
    appointment_id: null,
    block_reason: null
  };
  let db = {
    ...auth.db,
    slots: [...(auth.db.slots || []), slot]
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'agenda.slot.create',
    entity: slot.id,
    result: 'pass',
    detail: `Cupo creado en ${slot.establishment_id}`,
    after: deepClone(slot)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 201,
    payload: mutationPayload(auth, db, 'Cupo creado correctamente.', {
      slot: slotView(db, [slot], buildAccessContext(auth.runtime, db, auth.user))[0]
    })
  };
}

export async function updateSlotV1(token, slotId, body) {
  const auth = await authorize(token, 'agenda.write', {
    context: 'slot_update',
    entity: slotId,
    message: 'Tu rol no puede editar cupos.'
  });
  if (!auth.ok) {
    return auth;
  }
  const current = findSlotById(auth.db, slotId);
  if (!current) {
    return {
      ok: false,
      status: 404,
      error: 'slot_not_found',
      message: 'El cupo solicitado no existe.'
    };
  }
  if (current.status === 'reservado') {
    return conflictError('No puedes editar un cupo ya reservado; reprograma o cancela la cita primero.', 'slot_id');
  }
  const validation = validateSlotPayload(auth.db, body, current);
  if (!validation.ok) {
    return validation;
  }
  if (!withinScope(auth.access, validation.value.establishment_id)) {
    return denyPermission(auth, {
      permission: 'agenda.write',
      entity: slotId,
      establishmentId: validation.value.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance sobre ese cupo.',
      detail: `Edicion de cupo fuera de alcance en ${validation.value.establishment_id}`
    });
  }
  const updated = {
    ...current,
    ...validation.value,
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    slots: (auth.db.slots || []).map((item) => item.id === slotId ? updated : item)
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'agenda.slot.update',
    entity: slotId,
    result: 'pass',
    detail: 'Cupo actualizado',
    before: deepClone(current),
    after: deepClone(updated)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, 'Cupo actualizado correctamente.', {
      slot: slotView(db, [updated], buildAccessContext(auth.runtime, db, auth.user))[0]
    })
  };
}

export async function listContactTemplatesV1(token) {
  const auth = await authorize(token, 'contact.read', {
    context: 'contact_template_list',
    entity: 'contact_templates',
    message: 'Tu rol no puede consultar plantillas de contactabilidad.'
  });
  if (!auth.ok) {
    return auth;
  }
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      items: (auth.db.contact_templates || []).map(contactTemplateView)
    }
  };
}

export async function createContactTemplateV1(token, body = {}) {
  const auth = await authorize(token, 'template.manage', {
    context: 'contact_template_create',
    entity: 'contact_templates',
    message: 'Tu rol no puede administrar plantillas.'
  });
  if (!auth.ok) {
    return auth;
  }
  const validation = validateTemplatePayload(body);
  if (!validation.ok) {
    return validation;
  }
  const duplicated = (auth.db.contact_templates || []).find((item) =>
    item.code === validation.value.code &&
    item.version === validation.value.version
  );
  if (duplicated) {
    return conflictError('Ya existe una plantilla con ese codigo y version.', 'code');
  }
  const template = {
    id: nextSequenceId(auth.db.contact_templates || [], 'TPL'),
    ...validation.value,
    created_at: isoNow(),
    created_by: auth.user.username,
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    contact_templates: [template, ...(auth.db.contact_templates || [])]
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'contact.template.create',
    entity: template.id,
    result: 'pass',
    detail: `Plantilla ${template.code} v${template.version} creada`,
    after: deepClone(template)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 201,
    payload: mutationPayload(auth, db, 'Plantilla creada correctamente.', {
      template: contactTemplateView(template)
    })
  };
}

export async function updateContactTemplateV1(token, templateId, body = {}) {
  const auth = await authorize(token, 'template.manage', {
    context: 'contact_template_update',
    entity: templateId,
    message: 'Tu rol no puede editar plantillas.'
  });
  if (!auth.ok) {
    return auth;
  }
  const current = findContactTemplateById(auth.db, templateId);
  if (!current) {
    return {
      ok: false,
      status: 404,
      error: 'template_not_found',
      message: 'La plantilla solicitada no existe.'
    };
  }
  const validation = validateTemplatePayload(body, current);
  if (!validation.ok) {
    return validation;
  }
  const updated = {
    ...current,
    ...validation.value,
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    contact_templates: (auth.db.contact_templates || []).map((item) => item.id === templateId ? updated : item)
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'contact.template.update',
    entity: templateId,
    result: 'pass',
    detail: `Plantilla ${updated.code} actualizada`,
    before: deepClone(current),
    after: deepClone(updated)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, 'Plantilla actualizada correctamente.', {
      template: contactTemplateView(updated)
    })
  };
}

export async function listContactMessagesV1(token) {
  const auth = await authorize(token, 'contact.read', {
    context: 'contact_messages_list',
    entity: 'contact_messages',
    message: 'Tu rol no puede consultar la bandeja de contactabilidad.'
  });
  if (!auth.ok) {
    return auth;
  }
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      items: filterEntities(auth.db.contact_messages, auth.access, 'contact.read').map((message) => contactMessageView(auth.db, message)),
      cases: contactCaseView(auth.db, filterEntities(auth.db.contact_cases, auth.access, 'contact.read'), auth.access)
    }
  };
}

export async function sendContactMessageV1(token, body = {}) {
  const auth = await authorize(token, 'contact.write', {
    context: 'contact_message_send',
    entity: 'contact_messages',
    message: 'Tu rol no puede ejecutar envios de contactabilidad.'
  });
  if (!auth.ok) {
    return auth;
  }
  const validation = validateContactSendPayload(auth.db, body);
  if (!validation.ok) {
    if (validation.error === 'not_contactable') {
      let deniedDb = appendAudit(auth.db, {
        actor: auth.user.username,
        role: auth.user.role,
        action: 'contact.message.blocked',
        entity: validation.value?.patient?.id || body.patient_id || 'patient',
        result: 'blocked',
        detail: validation.message
      });
      await saveDatabase(deniedDb);
    }
    return validation;
  }
  if (!withinScope(auth.access, validation.value.patient.establishment_id)) {
    return denyPermission(auth, {
      permission: 'contact.write',
      entity: validation.value.patient.id,
      establishmentId: validation.value.patient.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance para contactar a ese paciente.',
      detail: `Contactabilidad fuera de alcance en ${validation.value.patient.establishment_id}`
    });
  }
  const currentCase = activeContactCaseFor(auth.db, validation.value.patient.id, validation.value.purpose);
  const contactCase = currentCase || {
    id: nextSequenceId(auth.db.contact_cases || [], 'CC'),
    patient_id: validation.value.patient.id,
    purpose: validation.value.purpose,
    establishment_id: validation.value.patient.establishment_id,
    status: 'activa',
    created_at: isoNow(),
    created_by: auth.user.username,
    updated_at: isoNow(),
    updated_by: auth.user.username,
    closed_reason: null,
    last_result: null
  };
  const message = {
    id: nextSequenceId(auth.db.contact_messages || [], 'MSG'),
    case_id: contactCase.id,
    patient_id: validation.value.patient.id,
    establishment_id: validation.value.patient.establishment_id,
    template_id: validation.value.template.id,
    contact_id: validation.value.contact.id,
    purpose: validation.value.purpose,
    channel: validation.value.channel,
    direction: 'outbound',
    status: 'sent',
    result: 'success',
    body: validation.value.detail,
    preview: visibleContactBody({
      body: validation.value.detail,
      contains_sensitive_detail: validation.value.contains_sensitive_detail
    }),
    contains_sensitive_detail: validation.value.contains_sensitive_detail,
    created_at: isoNow(),
    created_by: auth.user.username,
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  const updatedCase = {
    ...contactCase,
    status: 'activa',
    updated_at: isoNow(),
    updated_by: auth.user.username,
    last_message_id: message.id,
    last_result: message.result
  };
  let db = {
    ...auth.db,
    contact_cases: currentCase
      ? (auth.db.contact_cases || []).map((item) => item.id === updatedCase.id ? updatedCase : item)
      : [updatedCase, ...(auth.db.contact_cases || [])],
    contact_messages: [message, ...(auth.db.contact_messages || [])]
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'contact.message.send',
    entity: message.id,
    result: 'pass',
    detail: `Mensaje ${message.channel} para ${validation.value.patient.legal_name} con finalidad ${message.purpose}`,
    after: deepClone(message)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 201,
    payload: mutationPayload(auth, db, 'Envio de contactabilidad registrado.', {
      contact_case: contactCaseView(db, [updatedCase], buildAccessContext(auth.runtime, db, auth.user))[0],
      contact_message: contactMessageView(db, message)
    })
  };
}

export async function receiveContactWebhookV1(token, body = {}) {
  const auth = await authorize(token, 'contact.write', {
    context: 'contact_message_webhook',
    entity: 'contact_messages',
    message: 'Tu rol no puede registrar resultados de contactabilidad.'
  });
  if (!auth.ok) {
    return auth;
  }
  const validation = validateContactWebhookPayload(auth.db, body);
  if (!validation.ok) {
    return validation;
  }
  if (!withinScope(auth.access, validation.value.message.establishment_id)) {
    return denyPermission(auth, {
      permission: 'contact.write',
      entity: validation.value.message.id,
      establishmentId: validation.value.message.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance sobre ese envio.',
      detail: `Webhook de contactabilidad fuera de alcance en ${validation.value.message.establishment_id}`
    });
  }
  const currentCase = findContactCaseById(auth.db, validation.value.message.case_id);
  const updatedMessage = {
    ...validation.value.message,
    status: validation.value.status,
    result: validation.value.result,
    result_detail: validation.value.detail,
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  let nextStatus = currentCase?.status || 'activa';
  if (validation.value.result === 'bounce') {
    nextStatus = 'rebote';
  } else if (validation.value.result === 'escalated') {
    nextStatus = 'escalada';
  } else if (validation.value.result === 'success') {
    nextStatus = 'respuesta_recibida';
  }
  const updatedCase = currentCase ? {
    ...currentCase,
    status: nextStatus,
    updated_at: isoNow(),
    updated_by: auth.user.username,
    last_message_id: updatedMessage.id,
    last_result: updatedMessage.result
  } : null;
  let db = {
    ...auth.db,
    contact_messages: (auth.db.contact_messages || []).map((item) => item.id === updatedMessage.id ? updatedMessage : item),
    contact_cases: updatedCase
      ? (auth.db.contact_cases || []).map((item) => item.id === updatedCase.id ? updatedCase : item)
      : (auth.db.contact_cases || [])
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'contact.message.result',
    entity: updatedMessage.id,
    result: 'pass',
    detail: `${updatedMessage.status}: ${validation.value.detail}`,
    before: deepClone(validation.value.message),
    after: deepClone(updatedMessage)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, 'Resultado de contactabilidad registrado.', {
      contact_case: updatedCase ? contactCaseView(db, [updatedCase], buildAccessContext(auth.runtime, db, auth.user))[0] : null,
      contact_message: contactMessageView(db, updatedMessage)
    })
  };
}

export async function closeContactCaseV1(token, caseId, body = {}) {
  const auth = await authorize(token, 'contact.write', {
    context: 'contact_case_close',
    entity: caseId,
    message: 'Tu rol no puede cerrar casos de contactabilidad.'
  });
  if (!auth.ok) {
    return auth;
  }
  const contactCase = findContactCaseById(auth.db, caseId);
  if (!contactCase) {
    return {
      ok: false,
      status: 404,
      error: 'contact_case_not_found',
      message: 'El caso solicitado no existe.'
    };
  }
  if (!withinScope(auth.access, contactCase.establishment_id)) {
    return denyPermission(auth, {
      permission: 'contact.write',
      entity: contactCase.id,
      establishmentId: contactCase.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance sobre ese caso.',
      detail: `Cierre de contactabilidad fuera de alcance en ${contactCase.establishment_id}`
    });
  }
  const reason = normalizeText(body.reason);
  const closureKind = normalizeText(body.closure_kind || 'no_contactable');
  if (!CONTACT_CASE_CLOSE_REASONS.has(closureKind)) {
    return validationError('El tipo de cierre no es valido.', 'closure_kind');
  }
  if (!reason) {
    return validationError('Debes registrar un motivo de cierre.', 'reason');
  }
  const attempts = messagesForContactCase(auth.db, contactCase.id);
  const channels = [...new Set(attempts.map((item) => item.channel))];
  if (closureKind === 'no_contactable' && (attempts.length < 3 || channels.length < 2)) {
    return conflictError('RL-05 exige al menos 3 intentos por 2 canales antes de cerrar por no contactabilidad.', 'case_id');
  }
  const updatedCase = {
    ...contactCase,
    status: closureKind === 'no_contactable' ? 'no_contactable' : 'cerrada',
    updated_at: isoNow(),
    updated_by: auth.user.username,
    closed_reason: reason,
    last_result: closureKind
  };
  let db = {
    ...auth.db,
    contact_cases: (auth.db.contact_cases || []).map((item) => item.id === caseId ? updatedCase : item)
  };
  const sidraEnqueue = enqueueSidraEvent(db, auth.runtime, auth.user.username, {
    type: 'contact_case.closed',
    entity: 'contact_case',
    entity_id: updatedCase.id,
    establishment_id: updatedCase.establishment_id,
    simulation_default_result: 'acknowledged',
    payload: {
      closure_kind: closureKind,
      status: updatedCase.status,
      attempts: attempts.length
    }
  });
  db = sidraEnqueue.db;
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'contact.case.close',
    entity: caseId,
    result: 'pass',
    detail: `${closureKind}: ${reason}`,
    before: deepClone(contactCase),
    after: deepClone(updatedCase)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, 'Caso de contactabilidad cerrado.', {
      contact_case: contactCaseView(db, [updatedCase], buildAccessContext(auth.runtime, db, auth.user))[0]
    })
  };
}

export async function listWaitlistV1(token) {
  const auth = await authorize(token, 'waitlist.read', {
    context: 'waitlist_list',
    entity: 'waitlist',
    message: 'Tu rol no puede consultar lista de espera.'
  });
  if (!auth.ok) {
    return auth;
  }
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      items: waitlistView(auth.db, filterEntities(auth.db.waitlist, auth.access, 'waitlist.read'), auth.access, auth.runtime)
    }
  };
}

export async function createWaitlistEntryV1(token, body = {}) {
  const auth = await authorize(token, 'waitlist.write', {
    context: 'waitlist_create',
    entity: 'waitlist',
    message: 'Tu rol no puede registrar lista de espera.'
  });
  if (!auth.ok) {
    return auth;
  }
  const validation = validateWaitlistPayload(auth.db, body);
  if (!validation.ok) {
    return validation;
  }
  if (!withinScope(auth.access, validation.value.establishment_id)) {
    return denyPermission(auth, {
      permission: 'waitlist.write',
      entity: 'waitlist',
      establishmentId: validation.value.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance para registrar espera en ese establecimiento.',
      detail: `Lista de espera fuera de alcance en ${validation.value.establishment_id}`
    });
  }
  const duplicated = (auth.db.waitlist || []).find((item) =>
    item.patientId === validation.value.patient_id &&
    item.service_id === validation.value.service_id &&
    item.establishment_id === validation.value.establishment_id &&
    WAITLIST_ACTIVE_STATUSES.has(item.status)
  );
  if (duplicated) {
    return conflictError('Ya existe una necesidad activa equivalente en lista de espera.', 'patient_id', {
      duplicated_waitlist_id: duplicated.id
    });
  }
  const entry = {
    id: nextSequenceId(auth.db.waitlist || [], 'LE'),
    patientId: validation.value.patient_id,
    service_id: validation.value.service_id,
    service: validation.value.service.name,
    establishment_id: validation.value.establishment_id,
    source: validation.value.source,
    note: validation.value.note,
    status: 'activa',
    priority_rule: auth.runtime.waitlist?.priority_rule_id || 'RL-01',
    priority_reason: validation.value.patient.risk || 'Sin riesgo cronico',
    requested_at: isoNow(),
    created_at: isoNow(),
    created_by: auth.user.username,
    updated_at: isoNow(),
    updated_by: auth.user.username,
    active_offer_id: null,
    closed_reason: null
  };
  let db = {
    ...auth.db,
    waitlist: [entry, ...(auth.db.waitlist || [])]
  };
  db = appendWaitlistEvent(db, {
    waitlist_id: entry.id,
    type: 'waitlist.created',
    actor: auth.user.username,
    role: auth.user.role,
    detail: `Necesidad registrada para ${validation.value.service.name}`
  });
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'waitlist.create',
    entity: entry.id,
    result: 'pass',
    detail: `Espera creada para ${validation.value.service.name}`,
    after: deepClone(entry)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 201,
    payload: mutationPayload(auth, db, 'Solicitud agregada a lista de espera.', {
      waitlist_entry: waitlistView(db, [entry], buildAccessContext(auth.runtime, db, auth.user), auth.runtime)[0]
    })
  };
}

export async function closeWaitlistEntryV1(token, waitlistId, body = {}) {
  const auth = await authorize(token, 'waitlist.write', {
    context: 'waitlist_close',
    entity: waitlistId,
    message: 'Tu rol no puede cerrar lista de espera.'
  });
  if (!auth.ok) {
    return auth;
  }
  const entry = findWaitlistEntryById(auth.db, waitlistId);
  if (!entry) {
    return {
      ok: false,
      status: 404,
      error: 'waitlist_not_found',
      message: 'La espera solicitada no existe.'
    };
  }
  if (!withinScope(auth.access, entry.establishment_id)) {
    return denyPermission(auth, {
      permission: 'waitlist.write',
      entity: entry.id,
      establishmentId: entry.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance sobre esa espera.',
      detail: `Cierre de espera fuera de alcance en ${entry.establishment_id}`
    });
  }
  const reason = normalizeText(body.reason);
  if (!reason) {
    return validationError('El cierre requiere motivo.', 'reason');
  }
  let db = auth.db;
  const activeOffer = activeWaitlistOfferFor(db, entry.id);
  if (activeOffer) {
    db = {
      ...db,
      waitlist_offers: (db.waitlist_offers || []).map((item) => item.id === activeOffer.id ? {
        ...item,
        status: 'cancelada',
        resolved_at: isoNow(),
        resolution_reason: reason
      } : item)
    };
    db = releaseOfferSlot(db, activeOffer, auth.user.username);
  }
  const updated = {
    ...entry,
    status: 'cerrada',
    active_offer_id: null,
    closed_reason: reason,
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  db = {
    ...db,
    waitlist: (db.waitlist || []).map((item) => item.id === entry.id ? updated : item)
  };
  db = appendWaitlistEvent(db, {
    waitlist_id: entry.id,
    type: 'waitlist.closed',
    actor: auth.user.username,
    role: auth.user.role,
    detail: reason,
    offer_id: activeOffer?.id || null
  });
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'waitlist.close',
    entity: entry.id,
    result: 'pass',
    detail: reason,
    before: deepClone(entry),
    after: deepClone(updated)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, 'Espera cerrada correctamente.', {
      waitlist_entry: waitlistView(db, [updated], buildAccessContext(auth.runtime, db, auth.user), auth.runtime)[0]
    })
  };
}

export async function createWaitlistOfferV1(token, waitlistId, body = {}) {
  const auth = await authorize(token, 'waitlist.write', {
    context: 'waitlist_offer_create',
    entity: waitlistId,
    message: 'Tu rol no puede ofertar cupos desde lista de espera.'
  });
  if (!auth.ok) {
    return auth;
  }
  const entry = findWaitlistEntryById(auth.db, waitlistId);
  if (!entry) {
    return {
      ok: false,
      status: 404,
      error: 'waitlist_not_found',
      message: 'La espera solicitada no existe.'
    };
  }
  if (!withinScope(auth.access, entry.establishment_id)) {
    return denyPermission(auth, {
      permission: 'waitlist.write',
      entity: entry.id,
      establishmentId: entry.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance sobre esa espera.',
      detail: `Oferta de espera fuera de alcance en ${entry.establishment_id}`
    });
  }
  if (entry.status !== 'activa') {
    return conflictError('Solo puedes ofertar esperas activas.', 'status');
  }
  if (activeWaitlistOfferFor(auth.db, entry.id)) {
    return conflictError('La espera ya tiene una oferta pendiente.', 'waitlist_id');
  }
  const slotId = normalizeText(body.slot_id);
  const note = normalizeNullableText(body.note) || null;
  const slot = findSlotById(auth.db, slotId);
  if (!slot) {
    return {
      ok: false,
      status: 404,
      error: 'slot_not_found',
      message: 'El cupo ofertado no existe.'
    };
  }
  if (slot.status !== 'disponible' || slotIsPast(slot)) {
    return conflictError('El cupo ofertado debe estar disponible y vigente.', 'slot_id');
  }
  if (slot.service_id !== entry.service_id) {
    return validationError('El cupo ofertado debe corresponder a la misma prestacion.', 'slot_id');
  }
  if (!withinScope(auth.access, slot.establishment_id)) {
    return denyPermission(auth, {
      permission: 'waitlist.write',
      entity: slot.id,
      establishmentId: slot.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance sobre el cupo ofertado.',
      detail: `Cupo fuera de alcance en ${slot.establishment_id}`
    });
  }
  const candidates = waitlistSort(auth.runtime, auth.db, (auth.db.waitlist || []).filter((item) =>
    WAITLIST_ACTIVE_STATUSES.has(item.status) && item.service_id === slot.service_id
  ), slot);
  if (!candidates.length || candidates[0].id !== entry.id) {
    return conflictError('La oferta debe respetar la prioridad RL-01 visible.', 'waitlist_id', {
      recommended_waitlist_id: candidates[0]?.id || null,
      rule_applied: auth.runtime.waitlist?.priority_rule_id || 'RL-01'
    });
  }
  const offeredAt = isoNow();
  const expiresAt = new Date(Date.now() + waitlistOfferTtlMinutes(auth.runtime) * 60 * 1000).toISOString();
  const offer = {
    id: nextSequenceId(auth.db.waitlist_offers || [], 'WO'),
    waitlist_id: entry.id,
    patient_id: entry.patientId,
    service_id: entry.service_id,
    establishment_id: slot.establishment_id,
    slot_id: slot.id,
    status: 'pendiente_respuesta',
    note,
    offered_at: offeredAt,
    expires_at: expiresAt,
    reserved_until: expiresAt,
    offered_by: auth.user.username,
    rule_applied: auth.runtime.waitlist?.priority_rule_id || 'RL-01'
  };
  const updatedEntry = {
    ...entry,
    status: 'oferta_activa',
    active_offer_id: offer.id,
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    waitlist_offers: [offer, ...(auth.db.waitlist_offers || [])],
    waitlist: (auth.db.waitlist || []).map((item) => item.id === entry.id ? updatedEntry : item),
    slots: (auth.db.slots || []).map((item) => item.id === slot.id ? {
      ...item,
      status: 'reservado',
      waitlist_offer_id: offer.id,
      reserved_for: 'waitlist_offer',
      updated_at: isoNow(),
      updated_by: auth.user.username
    } : item)
  };
  db = appendWaitlistEvent(db, {
    waitlist_id: entry.id,
    type: 'waitlist.offer.created',
    actor: auth.user.username,
    role: auth.user.role,
    detail: `Oferta temporal sobre ${slot.id}`,
    slot_id: slot.id,
    offer_id: offer.id
  });
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'waitlist.offer.create',
    entity: offer.id,
    result: 'pass',
    detail: `Oferta creada para ${entry.id} usando ${slot.id}`,
    after: deepClone(offer)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 201,
    payload: mutationPayload(auth, db, 'Oferta temporal creada y cupo reservado.', {
      waitlist_entry: waitlistView(db, [updatedEntry], buildAccessContext(auth.runtime, db, auth.user), auth.runtime)[0],
      offer: waitlistOfferView(db, offer)
    })
  };
}

export async function resolveWaitlistOfferV1(token, offerId, body = {}) {
  const auth = await authorize(token, 'waitlist.write', {
    context: 'waitlist_offer_resolve',
    entity: offerId,
    message: 'Tu rol no puede resolver ofertas de lista de espera.'
  });
  if (!auth.ok) {
    return auth;
  }
  const offer = findWaitlistOfferById(auth.db, offerId);
  if (!offer) {
    return {
      ok: false,
      status: 404,
      error: 'waitlist_offer_not_found',
      message: 'La oferta solicitada no existe.'
    };
  }
  const entry = findWaitlistEntryById(auth.db, offer.waitlist_id);
  if (!entry) {
    return {
      ok: false,
      status: 404,
      error: 'waitlist_not_found',
      message: 'La espera asociada ya no existe.'
    };
  }
  if (!withinScope(auth.access, entry.establishment_id)) {
    return denyPermission(auth, {
      permission: 'waitlist.write',
      entity: entry.id,
      establishmentId: entry.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance sobre esta oferta.',
      detail: `Resolucion de oferta fuera de alcance en ${entry.establishment_id}`
    });
  }
  if (offer.status !== 'pendiente_respuesta') {
    return conflictError('La oferta ya fue resuelta.', 'status');
  }
  const resolution = normalizeText(body.resolution);
  const reason = normalizeText(body.reason);
  if (!['aceptada', 'rechazada'].includes(resolution)) {
    return validationError('La resolucion debe ser aceptada o rechazada.', 'resolution');
  }
  if (!reason) {
    return validationError('La resolucion requiere detalle.', 'reason');
  }
  const slot = findSlotById(auth.db, offer.slot_id);
  let db = {
    ...auth.db,
    waitlist_offers: (auth.db.waitlist_offers || []).map((item) => item.id === offer.id ? {
      ...item,
      status: resolution,
      resolved_at: isoNow(),
      resolution_reason: reason
    } : item)
  };
  let appointment = null;
  let updatedEntry = entry;
  if (resolution === 'aceptada') {
    if (!slot || slot.status !== 'reservado' || slot.waitlist_offer_id !== offer.id) {
      return conflictError('La oferta aceptada ya no conserva el cupo reservado.', 'offer_id');
    }
    appointment = {
      id: nextSequenceId(auth.db.appointments || [], 'C'),
      patientId: entry.patientId,
      slotId: slot.id,
      service_id: slot.service_id,
      professional_id: slot.professional_id,
      establishment_id: slot.establishment_id,
      channel: 'lista_espera_controlada',
      note: reason,
      status: 'agendada',
      created_at: isoNow(),
      updated_at: isoNow(),
      created_by: auth.user.username,
      updated_by: auth.user.username,
      source: 'waitlist_offer'
    };
    updatedEntry = {
      ...entry,
      status: 'resuelta',
      active_offer_id: null,
      closed_reason: reason,
      updated_at: isoNow(),
      updated_by: auth.user.username
    };
    db = {
      ...db,
      appointments: [appointment, ...(db.appointments || [])],
      waitlist: (db.waitlist || []).map((item) => item.id === entry.id ? updatedEntry : item),
      slots: (db.slots || []).map((item) => item.id === slot.id ? {
        ...item,
        status: 'reservado',
        waitlist_offer_id: offer.id,
        reserved_for: 'appointment',
        updated_at: isoNow(),
        updated_by: auth.user.username
      } : item)
    };
    db = appendAppointmentHistory(db, {
      appointment_id: appointment.id,
      action: 'waitlist.offer.accepted',
      to_status: 'agendada',
      slot_id: slot.id,
      actor: auth.user.username,
      role: auth.user.role,
      detail: reason,
      related_appointment_id: entry.id
    });
  } else {
    updatedEntry = {
      ...entry,
      status: 'activa',
      active_offer_id: null,
      updated_at: isoNow(),
      updated_by: auth.user.username
    };
    db = {
      ...db,
      waitlist: (db.waitlist || []).map((item) => item.id === entry.id ? updatedEntry : item)
    };
    db = releaseOfferSlot(db, offer, auth.user.username);
  }
  db = appendWaitlistEvent(db, {
    waitlist_id: entry.id,
    type: `waitlist.offer.${resolution}`,
    actor: auth.user.username,
    role: auth.user.role,
    detail: reason,
    slot_id: offer.slot_id,
    offer_id: offer.id,
    appointment_id: appointment?.id || null
  });
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: `waitlist.offer.${resolution}`,
    entity: offer.id,
    result: 'pass',
    detail: reason
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, resolution === 'aceptada' ? 'Oferta aceptada y cita creada.' : 'Oferta rechazada y cupo liberado.', {
      waitlist_entry: waitlistView(db, [updatedEntry], buildAccessContext(auth.runtime, db, auth.user), auth.runtime)[0],
      offer: waitlistOfferView(db, findWaitlistOfferById(db, offer.id)),
      appointment: appointment ? appointmentView(db, [appointment], buildAccessContext(auth.runtime, db, auth.user))[0] : null
    })
  };
}

export async function listAvailabilityV1(token, filters = {}) {
  const auth = await authorize(token, 'agenda.read', {
    context: 'availability_list',
    entity: 'availability',
    message: 'Tu rol no puede consultar disponibilidad.'
  });
  if (!auth.ok) {
    return auth;
  }
  const establishmentId = normalizeNullableText(filters.establishment_id);
  if (establishmentId && !withinScope(auth.access, establishmentId)) {
    return denyPermission(auth, {
      permission: 'agenda.read',
      entity: 'availability',
      establishmentId,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance sobre ese establecimiento.',
      detail: `Consulta de disponibilidad fuera de alcance en ${establishmentId}`
    });
  }
  const serviceId = normalizeNullableText(filters.service_id);
  const professionalId = normalizeNullableText(filters.professional_id);
  const agendaId = normalizeNullableText(filters.agenda_id);
  const items = slotView(auth.db, filterEntities(auth.db.slots, auth.access, 'agenda.read'), auth.access)
    .filter((slot) => slot.status === 'disponible' && !slotIsPast(slot))
    .filter((slot) => !establishmentId || slot.establishment_id === establishmentId)
    .filter((slot) => !serviceId || slot.service_id === serviceId)
    .filter((slot) => !professionalId || slot.professional_id === professionalId)
    .filter((slot) => !agendaId || slot.agenda_id === agendaId)
    .sort((left, right) => parseDate(left.starts_at) - parseDate(right.starts_at));
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      items
    }
  };
}

export async function createAppointmentV1(token, body) {
  const auth = await authorize(token, 'agenda.write', {
    context: 'appointment_create',
    entity: 'appointments',
    message: 'Tu rol no puede crear citas.'
  });
  if (!auth.ok) {
    return auth;
  }
  const validation = validateAppointmentCreation(auth.db, body);
  if (!validation.ok) {
    return validation;
  }
  const patientDenied = patientInScopeOrDenied(auth, validation.value.patient, 'agenda.write', 'Tu rol no tiene alcance sobre el paciente solicitado.');
  if (patientDenied) {
    return patientDenied;
  }
  if (!withinScope(auth.access, validation.value.slot.establishment_id)) {
    return denyPermission(auth, {
      permission: 'agenda.write',
      entity: validation.value.slot.id,
      establishmentId: validation.value.slot.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance sobre el cupo solicitado.',
      detail: `Reserva de cupo fuera de alcance en ${validation.value.slot.establishment_id}`
    });
  }
  const slot = validation.value.slot;
  const appointment = {
    id: nextSequenceId(auth.db.appointments || [], 'C'),
    patientId: validation.value.patient.id,
    slotId: slot.id,
    agenda_id: slot.agenda_id,
    professional_id: slot.professional_id,
    service_id: slot.service_id,
    establishment_id: slot.establishment_id,
    status: 'agendada',
    confirmation_status: 'pendiente',
    channel: validation.value.channel,
    note: validation.value.note,
    origin: validation.value.origin,
    starts_at: slot.starts_at,
    created_at: isoNow(),
    updated_at: isoNow(),
    created_by: auth.user.username,
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    appointments: [appointment, ...(auth.db.appointments || [])],
    slots: (auth.db.slots || []).map((item) => item.id === slot.id ? {
      ...item,
      status: 'reservado',
      appointment_id: appointment.id,
      updated_at: isoNow(),
      updated_by: auth.user.username
    } : item)
  };
  const sidraEnqueue = enqueueSidraEvent(db, auth.runtime, auth.user.username, {
    type: 'appointment.created',
    entity: 'appointment',
    entity_id: appointment.id,
    establishment_id: appointment.establishment_id,
    simulation_default_result: 'acknowledged',
    payload: {
      patient_id: appointment.patientId,
      slot_id: appointment.slotId,
      service_id: appointment.service_id
    }
  });
  db = sidraEnqueue.db;
  db = appendAppointmentHistory(db, {
    appointment_id: appointment.id,
    action: 'appointment.create',
    to_status: appointment.status,
    slot_id: slot.id,
    actor: auth.user.username,
    role: auth.user.role,
    detail: `Cita creada para ${validation.value.patient.id}`
  });
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'appointment.create',
    entity: appointment.id,
    result: 'pass',
    detail: `Cita creada sobre ${slot.id}`,
    after: deepClone(appointment)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 201,
    payload: mutationPayload(auth, db, 'Cita creada correctamente.', {
      appointment: appointmentView(db, [appointment], buildAccessContext(auth.runtime, db, auth.user))[0]
    })
  };
}

export async function getAppointmentV1(token, appointmentId) {
  const auth = await authorize(token, 'agenda.read', {
    context: 'appointment_detail',
    entity: appointmentId,
    message: 'Tu rol no puede consultar citas.'
  });
  if (!auth.ok) {
    return auth;
  }
  const appointment = findAppointmentById(auth.db, appointmentId);
  if (!appointment) {
    return {
      ok: false,
      status: 404,
      error: 'appointment_not_found',
      message: 'La cita solicitada no existe.'
    };
  }
  if (!withinScope(auth.access, appointment.establishment_id)) {
    return denyPermission(auth, {
      permission: 'agenda.read',
      entity: appointmentId,
      establishmentId: appointment.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance sobre la cita solicitada.',
      detail: `Consulta de cita fuera de alcance en ${appointment.establishment_id}`
    });
  }
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      item: appointmentView(auth.db, [appointment], auth.access)[0]
    }
  };
}

export async function listPatientAppointmentsV1(token, patientId) {
  const auth = await authorize(token, 'agenda.read', {
    context: 'patient_appointments',
    entity: patientId,
    message: 'Tu rol no puede consultar citas.'
  });
  if (!auth.ok) {
    return auth;
  }
  const patient = findPatientById(auth.db, patientId);
  const denied = patientInScopeOrDenied(auth, patient, 'agenda.read', 'Tu rol no tiene alcance sobre el paciente solicitado.');
  if (denied) {
    return denied;
  }
  const items = appointmentView(
    auth.db,
    filterEntities(auth.db.appointments, auth.access, 'agenda.read').filter((item) => item.patientId === patientId),
    auth.access
  );
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      items
    }
  };
}

export async function confirmAppointmentV1(token, appointmentId, body = {}) {
  const auth = await authorize(token, 'agenda.write', {
    context: 'appointment_confirm',
    entity: appointmentId,
    message: 'Tu rol no puede confirmar citas.'
  });
  if (!auth.ok) {
    return auth;
  }
  const current = findAppointmentById(auth.db, appointmentId);
  if (!current) {
    return {
      ok: false,
      status: 404,
      error: 'appointment_not_found',
      message: 'La cita solicitada no existe.'
    };
  }
  if (!withinScope(auth.access, current.establishment_id)) {
    return denyPermission(auth, {
      permission: 'agenda.write',
      entity: appointmentId,
      establishmentId: current.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance sobre la cita solicitada.',
      detail: `Confirmacion fuera de alcance en ${current.establishment_id}`
    });
  }
  if (!APPOINTMENT_ACTIVE_STATUSES.has(current.status)) {
    return conflictError('Solo puedes confirmar citas activas.', 'appointment_id');
  }
  const updated = {
    ...current,
    status: 'confirmada',
    confirmation_status: 'confirmada',
    confirmation_channel: normalizeText(body.channel || current.channel || 'telefono'),
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    appointments: (auth.db.appointments || []).map((item) => item.id === appointmentId ? updated : item)
  };
  db = appendAppointmentHistory(db, {
    appointment_id: appointmentId,
    action: 'appointment.confirm',
    from_status: current.status,
    to_status: updated.status,
    slot_id: updated.slotId,
    actor: auth.user.username,
    role: auth.user.role,
    detail: `Confirmada por ${updated.confirmation_channel}`
  });
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'appointment.confirm',
    entity: appointmentId,
    result: 'pass',
    detail: `Cita confirmada por ${updated.confirmation_channel}`,
    before: deepClone(current),
    after: deepClone(updated)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, 'Cita confirmada correctamente.', {
      appointment: appointmentView(db, [updated], buildAccessContext(auth.runtime, db, auth.user))[0]
    })
  };
}

export async function cancelAppointmentV1(token, appointmentId, body = {}) {
  const auth = await authorize(token, 'agenda.write', {
    context: 'appointment_cancel',
    entity: appointmentId,
    message: 'Tu rol no puede cancelar citas.'
  });
  if (!auth.ok) {
    return auth;
  }
  const current = findAppointmentById(auth.db, appointmentId);
  if (!current) {
    return {
      ok: false,
      status: 404,
      error: 'appointment_not_found',
      message: 'La cita solicitada no existe.'
    };
  }
  if (!withinScope(auth.access, current.establishment_id)) {
    return denyPermission(auth, {
      permission: 'agenda.write',
      entity: appointmentId,
      establishmentId: current.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance sobre la cita solicitada.',
      detail: `Cancelacion fuera de alcance en ${current.establishment_id}`
    });
  }
  if (!APPOINTMENT_ACTIVE_STATUSES.has(current.status)) {
    return conflictError('Solo puedes cancelar citas activas.', 'appointment_id');
  }
  const reason = normalizeText(body.reason);
  if (!reason) {
    return validationError('La cancelacion requiere causal.', 'reason');
  }
  const slot = findSlotById(auth.db, current.slotId);
  if (!slot || !appointmentAllowsRelease(auth.runtime, slot)) {
    return conflictError('La regla local RL-04 bloquea liberar o cancelar este cupo dentro de la ventana de corte.', 'reason');
  }
  const updated = {
    ...current,
    status: 'cancelada',
    cancelled_reason: reason,
    cancelled_at: isoNow(),
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    appointments: (auth.db.appointments || []).map((item) => item.id === appointmentId ? updated : item),
    slots: (auth.db.slots || []).map((item) => item.id === current.slotId ? {
      ...item,
      status: 'disponible',
      appointment_id: null,
      updated_at: isoNow(),
      updated_by: auth.user.username
    } : item)
  };
  const sidraCancelEnqueue = enqueueSidraEvent(db, auth.runtime, auth.user.username, {
    type: 'appointment.cancelled',
    entity: 'appointment',
    entity_id: updated.id,
    establishment_id: updated.establishment_id,
    simulation_default_result: 'acknowledged',
    payload: {
      reason,
      slot_id: updated.slotId
    }
  });
  db = sidraCancelEnqueue.db;
  db = appendAppointmentHistory(db, {
    appointment_id: appointmentId,
    action: 'appointment.cancel',
    from_status: current.status,
    to_status: updated.status,
    slot_id: current.slotId,
    actor: auth.user.username,
    role: auth.user.role,
    detail: reason
  });
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'appointment.cancel',
    entity: appointmentId,
    result: 'pass',
    detail: reason,
    before: deepClone(current),
    after: deepClone(updated)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, 'Cita cancelada correctamente.', {
      appointment: appointmentView(db, [updated], buildAccessContext(auth.runtime, db, auth.user))[0]
    })
  };
}

export async function rescheduleAppointmentV1(token, appointmentId, body = {}) {
  const auth = await authorize(token, 'agenda.write', {
    context: 'appointment_reschedule',
    entity: appointmentId,
    message: 'Tu rol no puede reprogramar citas.'
  });
  if (!auth.ok) {
    return auth;
  }
  const current = findAppointmentById(auth.db, appointmentId);
  if (!current) {
    return {
      ok: false,
      status: 404,
      error: 'appointment_not_found',
      message: 'La cita solicitada no existe.'
    };
  }
  if (!withinScope(auth.access, current.establishment_id)) {
    return denyPermission(auth, {
      permission: 'agenda.write',
      entity: appointmentId,
      establishmentId: current.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance sobre la cita solicitada.',
      detail: `Reprogramacion fuera de alcance en ${current.establishment_id}`
    });
  }
  if (!APPOINTMENT_ACTIVE_STATUSES.has(current.status)) {
    return conflictError('Solo puedes reprogramar citas activas.', 'appointment_id');
  }
  const currentSlot = findSlotById(auth.db, current.slotId);
  if (!currentSlot || !appointmentAllowsRelease(auth.runtime, currentSlot)) {
    return conflictError('La regla local RL-03 bloquea la reprogramacion dentro de la ventana de corte.', 'slot_id');
  }
  const targetSlotId = normalizeText(body.new_slot_id ?? body.slot_id);
  const reason = normalizeText(body.reason);
  if (!targetSlotId) {
    return validationError('Debes indicar el nuevo cupo para reprogramar.', 'new_slot_id');
  }
  if (!reason) {
    return validationError('La reprogramacion requiere causal.', 'reason');
  }
  const targetSlot = findSlotById(auth.db, targetSlotId);
  if (!targetSlot) {
    return {
      ok: false,
      status: 404,
      error: 'slot_not_found',
      message: 'El nuevo cupo solicitado no existe.'
    };
  }
  if (!withinScope(auth.access, targetSlot.establishment_id)) {
    return denyPermission(auth, {
      permission: 'agenda.write',
      entity: targetSlotId,
      establishmentId: targetSlot.establishment_id,
      deniedKind: 'scope',
      message: 'Tu rol no tiene alcance sobre el nuevo cupo.',
      detail: `Reprogramacion hacia cupo fuera de alcance en ${targetSlot.establishment_id}`
    });
  }
  if (targetSlot.status !== 'disponible' || slotIsPast(targetSlot)) {
    return conflictError('El nuevo cupo no esta disponible para reprogramar.', 'new_slot_id');
  }
  if (targetSlot.id === current.slotId) {
    return validationError('Debes seleccionar un cupo distinto para reprogramar.', 'new_slot_id');
  }
  const replacement = {
    id: nextSequenceId(auth.db.appointments || [], 'C'),
    patientId: current.patientId,
    slotId: targetSlot.id,
    agenda_id: targetSlot.agenda_id,
    professional_id: targetSlot.professional_id,
    service_id: targetSlot.service_id,
    establishment_id: targetSlot.establishment_id,
    status: 'agendada',
    confirmation_status: 'pendiente',
    channel: current.channel,
    note: current.note,
    origin: 'reprogramacion_interna',
    starts_at: targetSlot.starts_at,
    reprogrammed_from: current.id,
    created_at: isoNow(),
    updated_at: isoNow(),
    created_by: auth.user.username,
    updated_by: auth.user.username
  };
  const updatedCurrent = {
    ...current,
    status: 'reprogramada',
    reprogrammed_to: replacement.id,
    reschedule_reason: reason,
    updated_at: isoNow(),
    updated_by: auth.user.username
  };
  let db = {
    ...auth.db,
    appointments: [replacement, ...(auth.db.appointments || []).map((item) => item.id === appointmentId ? updatedCurrent : item)],
    slots: (auth.db.slots || []).map((item) => {
      if (item.id === current.slotId) {
        return {
          ...item,
          status: 'disponible',
          appointment_id: null,
          updated_at: isoNow(),
          updated_by: auth.user.username
        };
      }
      if (item.id === targetSlot.id) {
        return {
          ...item,
          status: 'reservado',
          appointment_id: replacement.id,
          updated_at: isoNow(),
          updated_by: auth.user.username
        };
      }
      return item;
    })
  };
  const sidraRescheduleEnqueue = enqueueSidraEvent(db, auth.runtime, auth.user.username, {
    type: 'appointment.rescheduled',
    entity: 'appointment',
    entity_id: replacement.id,
    establishment_id: replacement.establishment_id,
    simulation_default_result: 'acknowledged',
    payload: {
      previous_appointment_id: current.id,
      new_slot_id: replacement.slotId,
      old_slot_id: current.slotId,
      reason
    }
  });
  db = sidraRescheduleEnqueue.db;
  db = appendAppointmentHistory(db, {
    appointment_id: current.id,
    action: 'appointment.reschedule.out',
    from_status: current.status,
    to_status: updatedCurrent.status,
    slot_id: current.slotId,
    related_appointment_id: replacement.id,
    actor: auth.user.username,
    role: auth.user.role,
    detail: reason
  });
  db = appendAppointmentHistory(db, {
    appointment_id: replacement.id,
    action: 'appointment.reschedule.in',
    to_status: replacement.status,
    slot_id: replacement.slotId,
    related_appointment_id: current.id,
    actor: auth.user.username,
    role: auth.user.role,
    detail: `Nueva cita desde ${current.id}`
  });
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'appointment.reschedule',
    entity: current.id,
    result: 'pass',
    detail: `${reason} -> ${replacement.id}`,
    before: deepClone(current),
    after: deepClone(updatedCurrent)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: mutationPayload(auth, db, 'Cita reprogramada correctamente.', {
      previous_appointment: appointmentView(db, [updatedCurrent], buildAccessContext(auth.runtime, db, auth.user))[0],
      appointment: appointmentView(db, [replacement], buildAccessContext(auth.runtime, db, auth.user))[0]
    })
  };
}

export async function createAgendaBlockV1(token, body = {}) {
  const auth = await authorize(token, 'agenda.block', {
    context: 'agenda_block_create',
    entity: 'agenda_blocks',
    message: 'Tu rol no puede bloquear agendas o cupos.'
  });
  if (!auth.ok) {
    return auth;
  }
  const reason = normalizeText(body.reason);
  const slotIds = Array.isArray(body.slot_ids)
    ? body.slot_ids.map((item) => String(item))
    : body.slot_id ? [String(body.slot_id)] : [];
  if (!reason) {
    return validationError('El bloqueo requiere motivo.', 'reason');
  }
  if (!slotIds.length) {
    return validationError('Debes indicar al menos un cupo a bloquear.', 'slot_ids');
  }
  const slots = slotIds.map((slotId) => findSlotById(auth.db, slotId)).filter(Boolean);
  if (slots.length !== slotIds.length) {
    return {
      ok: false,
      status: 404,
      error: 'slot_not_found',
      message: 'Uno o mas cupos del bloqueo no existen.'
    };
  }
  for (const slot of slots) {
    if (!withinScope(auth.access, slot.establishment_id)) {
      return denyPermission(auth, {
        permission: 'agenda.block',
        entity: slot.id,
        establishmentId: slot.establishment_id,
        deniedKind: 'scope',
        message: 'Tu rol no tiene alcance sobre uno de los cupos solicitados.',
        detail: `Bloqueo fuera de alcance en ${slot.establishment_id}`
      });
    }
  }
  const impactedAppointments = (auth.db.appointments || []).filter((appointment) =>
    slotIds.includes(appointment.slotId) && APPOINTMENT_ACTIVE_STATUSES.has(appointment.status)
  );
  const block = {
    id: nextSequenceId(auth.db.agenda_blocks || [], 'BK'),
    slot_ids: slotIds,
    agenda_id: slots[0]?.agenda_id || null,
    establishment_id: slots[0]?.establishment_id || null,
    reason,
    impacted_appointment_ids: impactedAppointments.map((item) => item.id),
    created_at: isoNow(),
    created_by: auth.user.username
  };
  let db = {
    ...auth.db,
    agenda_blocks: [block, ...(auth.db.agenda_blocks || [])],
    slots: (auth.db.slots || []).map((item) => slotIds.includes(item.id) ? {
      ...item,
      status: 'bloqueado',
      block_reason: reason,
      updated_at: isoNow(),
      updated_by: auth.user.username
    } : item),
    appointments: (auth.db.appointments || []).map((item) => impactedAppointments.some((appointment) => appointment.id === item.id) ? {
      ...item,
      status: 'reprogramacion_solicitada',
      updated_at: isoNow(),
      updated_by: auth.user.username
    } : item)
  };
  for (const appointment of impactedAppointments) {
    db = appendAppointmentHistory(db, {
      appointment_id: appointment.id,
      action: 'agenda.block.impact',
      from_status: appointment.status,
      to_status: 'reprogramacion_solicitada',
      slot_id: appointment.slotId,
      actor: auth.user.username,
      role: auth.user.role,
      detail: reason
    });
  }
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'agenda.block.success',
    entity: block.id,
    result: 'pass',
    detail: `${reason} impacta ${impactedAppointments.length} cita(s)`,
    after: deepClone(block)
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 201,
    payload: mutationPayload(auth, db, 'Bloqueo aplicado correctamente.', {
      block,
      impact: {
        blocked_slots: slotIds.length,
        impacted_appointments: impactedAppointments.map((item) => item.id)
      }
    })
  };
}

export async function blockSlot(token, slotId, reason = 'Bloqueo manual RBAC') {
  const result = await createAgendaBlockV1(token, {
    slot_id: slotId,
    reason
  });
  if (!result.ok) {
    return result;
  }
  return {
    ...result,
    status: 200,
    payload: {
      ...result.payload,
      message: 'Cupo bloqueado correctamente.'
    }
  };
}

export async function logoutSession(token) {
  const auth = await requireSession(token, 'logout');
  if (!auth.ok) {
    return auth;
  }
  let db = auth.db;
  db = {
    ...db,
    sessions: (db.sessions || []).map((session) => session.id === auth.session.id ? {
      ...session,
      revoked_at: isoNow(),
      revoked_reason: 'logout'
    } : session)
  };
  db = appendAudit(db, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'auth.logout.success',
    entity: 'session',
    result: 'pass',
    detail: 'Sesion cerrada por el usuario'
  });
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      message: 'Sesion cerrada.'
    }
  };
}

export async function resetDatabaseForUser(token) {
  const auth = await requireSession(token, 'demo_reset');
  if (!auth.ok) {
    return auth;
  }
  const runtime = await loadRuntime();
  const seed = await readJson(seedUrlFromRuntime(runtime));
  const user = findUserById(seed, auth.user.id);
  let db = appendAudit(seed, {
    actor: auth.user.username,
    role: auth.user.role,
    action: 'demo.reset',
    entity: 'database',
    result: 'pass',
    detail: 'Base local restaurada desde seed R06'
  });
  const { token: nextToken, record } = buildSession(db, runtime, user || auth.user);
  db = {
    ...db,
    sessions: [record]
  };
  await saveDatabase(db);
  return {
    ok: true,
    status: 200,
    payload: {
      status: 'ok',
      auth: {
        token: nextToken,
        expires_at: record.expires_at
      },
      bootstrap: composeBootstrap(runtime, db, user || auth.user, record)
    }
  };
}

export function storageLocation() {
  return sqliteStorageLocation();
}
