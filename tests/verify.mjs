import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const port = 4315;
const baseUrl = `http://127.0.0.1:${port}`;
const runtime = JSON.parse(readFileSync(new URL('../config/operational.json', import.meta.url), 'utf8'));

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await requestJson('/health');
      if (response.status === 200) {
        return response.payload;
      }
    } catch {
    }
    await delay(200);
  }
  throw new Error('backend did not become healthy');
}

function startBackend() {
  const child = spawn(process.execPath, ['src/backend/server.mjs', '--port', String(port)], {
    cwd: workspaceRoot,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  return { child, stderrRef: () => stderr };
}

async function stopBackend(child) {
  child.kill('SIGTERM');
  await delay(250);
}

function authHeaders(sessionKey) {
  return {
    Authorization: `Bearer ${sessionKey}`
  };
}

async function loginAs(username, password) {
  return requestJson('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
}

assert(runtime.version === 'v0042', 'runtime version must be v0042');
assert(runtime.phase.includes('Ajustes de usabilidad operativa y seed demo realista'), 'runtime phase must describe the v0042 usability and dataset delivery');
assert(Array.isArray(runtime.appointments?.statuses), 'runtime must expose appointment statuses');
assert(runtime.waitlist?.priority_rule_id === 'RL-01', 'runtime must expose RL-01 waitlist rule');
assert(runtime.contactability?.required_attempts_for_no_contact === 3, 'runtime must expose RL-05 attempts');
assert(Array.isArray(runtime.contactability?.insecure_channels_for_sensitive), 'runtime must expose insecure channels');
assert(runtime.campaigns?.approval_required === true, 'runtime must require campaign approval');
assert(runtime.campaigns?.identifiable_export === false, 'runtime must block identifiable export');
assert(runtime.reports?.default_periodicity === 'monthly', 'runtime must expose monthly reports');
assert(runtime.continuity?.backup_engine === 'local_sqlite_snapshot', 'runtime must expose local sqlite backup engine');

let backend = startBackend();
let createdProfessionalId = null;
let createdServiceId = null;
let createdAgendaId = null;
let createdSlotId = null;
let createdAppointmentId = null;
let reprogrammedAppointmentId = null;
let persistedAppointmentId = null;
let highRiskPatientId = null;
let regularRiskPatientId = null;
let highPriorityWaitlistId = null;
let regularPriorityWaitlistId = null;
let createdWaitlistOfferId = null;

try {
  const health = await waitForHealth();
  assert(health.status === 'ok', 'health must return ok');
  assert(health.version === runtime.version, 'health version must match runtime version');
  assert(health.authorization === 'rbac', 'health must expose rbac authorization');

  const noToken = await requestJson('/api/bootstrap');
  assert(noToken.status === 401, 'bootstrap without session must return 401');

  const invalidLogin = await loginAs('admin.comunal', 'incorrecta');
  assert(invalidLogin.status === 401, 'invalid login must return 401');

  const inactiveLogin = await loginAs('inactivo.demo', 'Quili.Inactivo!2026');
  assert(inactiveLogin.status === 403, 'inactive user must be rejected');

  const initialAdminLogin = await loginAs('admin.comunal', 'Quili.Admin!2026');
  assert(initialAdminLogin.status === 200, 'initial admin login must succeed');
  const initialReset = await requestJson('/api/demo/reset', {
    method: 'POST',
    headers: authHeaders(initialAdminLogin.payload.auth.token)
  });
  assert(initialReset.status === 200, 'initial demo reset must succeed');

  const adminLogin = await loginAs('admin.comunal', 'Quili.Admin!2026');
  const gestorLogin = await loginAs('gestor.cesfam', 'Quili.Gestor!2026');
  const professionalLogin = await loginAs('profesional.demo', 'Quili.Pro!2026');
  const auditorLogin = await loginAs('auditor.demo', 'Quili.Audit!2026');
  const expiringLogin = await loginAs('expira.demo', 'Quili.Expira!2026');

  assert(adminLogin.status === 200, 'admin login must succeed');
  assert(gestorLogin.status === 200, 'gestor login must succeed');
  assert(professionalLogin.status === 200, 'professional login must succeed');
  assert(auditorLogin.status === 200, 'auditor login must succeed');
  assert(expiringLogin.status === 200, 'expiring login must succeed');

  const adminBearer = adminLogin.payload.auth.token;
  const gestorBearer = gestorLogin.payload.auth.token;
  const professionalBearer = professionalLogin.payload.auth.token;
  const auditorBearer = auditorLogin.payload.auth.token;
  const expiringBearer = expiringLogin.payload.auth.token;

  const adminSession = await requestJson('/api/auth/session', { headers: authHeaders(adminBearer) });
  assert(adminSession.status === 200, 'admin session endpoint must work');
  assert(adminSession.payload.rbac?.action_access?.agenda_write === true, 'admin session must expose agenda write');

  const seededBootstrap = await requestJson('/api/bootstrap', { headers: authHeaders(adminBearer) });
  assert(seededBootstrap.status === 200, 'admin bootstrap must succeed');
  assert(seededBootstrap.payload.summary?.patients >= 100, 'bootstrap must expose seeded patient volume');
  assert(seededBootstrap.payload.appointments?.length >= 120, 'bootstrap must expose seeded appointment volume');
  assert(seededBootstrap.payload.waitlist?.length >= 40, 'bootstrap must expose seeded waitlist volume');

  const professionalCreate = await requestJson('/api/v1/citas', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(professionalBearer)
    },
    body: JSON.stringify({
      patient_id: 'P-1003',
      slot_id: 'S-03',
      channel: 'meson'
    })
  });
  assert(professionalCreate.status === 403, 'professional appointment create must be denied');
  assert(professionalCreate.payload.error === 'permission_denied', 'professional denial must be structured');

  const createProfessional = await requestJson('/api/v1/profesionales', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      name: 'Dra. Agenda Demo',
      discipline: 'Odontologia',
      establishment_id: 'cesfam-bauza',
      status: 'active'
    })
  });
  assert(createProfessional.status === 201, 'professional create must succeed');
  createdProfessionalId = createProfessional.payload.professional?.id;
  assert(Boolean(createdProfessionalId), 'created professional id must exist');

  const createService = await requestJson('/api/v1/prestaciones', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      name: 'Odontologia preventiva demo',
      code: 'ODO-DEMO-01',
      duration_minutes: 30,
      establishment_id: 'cesfam-bauza',
      status: 'active'
    })
  });
  assert(createService.status === 201, 'service create must succeed');
  createdServiceId = createService.payload.service?.id;
  assert(Boolean(createdServiceId), 'created service id must exist');

  const createAgenda = await requestJson('/api/v1/agendas', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      name: 'Agenda demo odontologia',
      establishment_id: 'cesfam-bauza',
      professional_id: createdProfessionalId,
      service_id: createdServiceId,
      status: 'active'
    })
  });
  assert(createAgenda.status === 201, 'agenda create must succeed');
  createdAgendaId = createAgenda.payload.agenda?.id;
  assert(Boolean(createdAgendaId), 'created agenda id must exist');

  const createSlot = await requestJson('/api/v1/cupos', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      agenda_id: createdAgendaId,
      starts_at: '2030-07-17T12:00:00.000Z',
      ends_at: '2030-07-17T12:30:00.000Z',
      status: 'disponible',
      note: 'Cupo demo API'
    })
  });
  assert(createSlot.status === 201, 'slot create must succeed');
  createdSlotId = createSlot.payload.slot?.id;
  assert(Boolean(createdSlotId), 'created slot id must exist');

  const updateProfessional = await requestJson(`/api/v1/profesionales/${createdProfessionalId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      name: 'Dra. Agenda Demo Actualizada',
      discipline: 'Odontologia',
      establishment_id: 'cesfam-bauza',
      status: 'active'
    })
  });
  assert(updateProfessional.status === 200, 'professional patch must succeed');

  const updateService = await requestJson(`/api/v1/prestaciones/${createdServiceId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      name: 'Odontologia preventiva demo actualizada',
      code: 'ODO-DEMO-01',
      duration_minutes: 40,
      establishment_id: 'cesfam-bauza',
      status: 'active'
    })
  });
  assert(updateService.status === 200, 'service patch must succeed');

  const updateAgenda = await requestJson(`/api/v1/agendas/${createdAgendaId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      name: 'Agenda demo odontologia AM',
      establishment_id: 'cesfam-bauza',
      professional_id: createdProfessionalId,
      service_id: createdServiceId,
      status: 'active'
    })
  });
  assert(updateAgenda.status === 200, 'agenda patch must succeed');

  const updateSlot = await requestJson(`/api/v1/cupos/${createdSlotId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      agenda_id: createdAgendaId,
      starts_at: '2030-07-17T12:30:00.000Z',
      ends_at: '2030-07-17T13:00:00.000Z',
      status: 'disponible',
      note: 'Cupo demo API actualizado'
    })
  });
  assert(updateSlot.status === 200, 'slot patch must succeed');

  const availability = await requestJson(`/api/v1/agendas/disponibilidad?establishment_id=cesfam-bauza&service_id=${createdServiceId}`, {
    headers: authHeaders(gestorBearer)
  });
  assert(availability.status === 200, 'availability query must succeed');
  assert(availability.payload.items.some((item) => item.id === createdSlotId), 'availability must include created slot');

  const createAppointment = await requestJson('/api/v1/citas', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      patient_id: 'P-1002',
      slot_id: createdSlotId,
      channel: 'meson',
      note: 'Reserva API R04'
    })
  });
  assert(createAppointment.status === 201, 'appointment create must succeed');
  createdAppointmentId = createAppointment.payload.appointment?.id;
  assert(Boolean(createdAppointmentId), 'created appointment id must exist');
  assert(createAppointment.payload.appointment?.status === 'agendada', 'new appointment must start agendada');

  const duplicateAppointment = await requestJson('/api/v1/citas', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(adminBearer)
    },
    body: JSON.stringify({
      patient_id: 'P-1004',
      slot_id: createdSlotId,
      channel: 'telefono',
      note: 'Intento doble reserva'
    })
  });
  assert(duplicateAppointment.status === 409, 'double booking must return 409');

  const confirmAppointment = await requestJson(`/api/v1/citas/${createdAppointmentId}/confirmacion`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      channel: 'telefono'
    })
  });
  assert(confirmAppointment.status === 200, 'appointment confirm must succeed');
  assert(confirmAppointment.payload.appointment?.status === 'confirmada', 'confirmed appointment must become confirmada');

  const detailBeforeReprogram = await requestJson(`/api/v1/citas/${createdAppointmentId}`, {
    headers: authHeaders(gestorBearer)
  });
  assert(detailBeforeReprogram.status === 200, 'appointment detail before reprogram must succeed');
  assert(detailBeforeReprogram.payload.item?.history.some((item) => item.action === 'appointment.confirm'), 'history must include confirm');

  const reprogramAppointment = await requestJson(`/api/v1/citas/${createdAppointmentId}/reprogramar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      new_slot_id: 'S-07',
      reason: 'Cambio de agenda del paciente'
    })
  });
  assert(reprogramAppointment.status === 200, 'appointment reschedule must succeed');
  assert(reprogramAppointment.payload.previous_appointment?.status === 'reprogramada', 'previous appointment must become reprogramada');
  reprogrammedAppointmentId = reprogramAppointment.payload.appointment?.id;
  assert(Boolean(reprogrammedAppointmentId), 'reprogrammed appointment id must exist');

  const blockedSlot = await requestJson('/api/v1/agendas/bloqueos', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      slot_ids: ['S-06'],
      reason: 'Contingencia box respiratorio'
    })
  });
  assert(blockedSlot.status === 201, 'agenda block must succeed');
  assert(blockedSlot.payload.impact?.blocked_slots === 1, 'agenda block must report blocked slot count');

  const blockedCreate = await requestJson('/api/v1/citas', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      patient_id: 'P-1004',
      slot_id: 'S-06',
      channel: 'meson',
      note: 'No debe reservarse'
    })
  });
  assert(blockedCreate.status === 409, 'blocked slot appointment create must fail');

  const cancelAppointmentResult = await requestJson(`/api/v1/citas/${reprogrammedAppointmentId}/cancelar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      reason: 'Paciente solicito anular'
    })
  });
  assert(cancelAppointmentResult.status === 200, 'appointment cancel must succeed');
  assert(cancelAppointmentResult.payload.appointment?.status === 'cancelada', 'appointment cancel must become cancelada');

  const createPersistedAppointment = await requestJson('/api/v1/citas', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      patient_id: 'P-1004',
      slot_id: 'S-05',
      channel: 'telefono',
      note: 'Cita para verificar persistencia'
    })
  });
  assert(createPersistedAppointment.status === 201, 'persisted appointment create must succeed');
  persistedAppointmentId = createPersistedAppointment.payload.appointment?.id;
  assert(Boolean(persistedAppointmentId), 'persisted appointment id must exist');

  const patientAppointments = await requestJson('/api/v1/pacientes/P-1002/citas', {
    headers: authHeaders(gestorBearer)
  });
  assert(patientAppointments.status === 200, 'patient appointments list must succeed');
  assert(patientAppointments.payload.items.some((item) => item.id === createdAppointmentId), 'patient appointments must include original appointment');

  const auditorAppointmentDetail = await requestJson(`/api/v1/citas/${persistedAppointmentId}`, {
    headers: authHeaders(auditorBearer)
  });
  assert(auditorAppointmentDetail.status === 403, 'auditor appointment detail must be denied');

  const auditorAudit = await requestJson('/api/audit', { headers: authHeaders(auditorBearer) });
  assert(auditorAudit.status === 200, 'auditor audit endpoint must work');
  assert(auditorAudit.payload.items.some((item) => item.action === 'appointment.create'), 'audit must record appointment create');
  assert(auditorAudit.payload.items.some((item) => item.action === 'appointment.reschedule'), 'audit must record appointment reschedule');
  assert(auditorAudit.payload.items.some((item) => item.action === 'agenda.block.success'), 'audit must record agenda block');

  const createHighRiskPatient = await requestJson('/api/v1/pacientes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      rut: '55.555.555-5',
      identifier_kind: 'definitive',
      legal_name: 'Elena Prioridad Cronica',
      social_name: 'Elena Cronica',
      birth_date: '1970-05-05',
      establishment_id: 'cesfam-bauza',
      sector: 'Bauza Norte',
      risk: 'Paciente cronico cardiovascular',
      notes: 'Alta para validar RL-01'
    })
  });
  assert(createHighRiskPatient.status === 201, 'high risk patient create must succeed');
  highRiskPatientId = createHighRiskPatient.payload.patient?.id;

  const createRegularRiskPatient = await requestJson('/api/v1/pacientes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      rut: '66.666.666-6',
      identifier_kind: 'definitive',
      legal_name: 'Pedro Prioridad Regular',
      social_name: 'Pedro Regular',
      birth_date: '1989-06-06',
      establishment_id: 'cesfam-bauza',
      sector: 'Bauza Sur',
      risk: 'Consulta preventiva',
      notes: 'Alta para validar duplicados de espera'
    })
  });
  assert(createRegularRiskPatient.status === 201, 'regular risk patient create must succeed');
  regularRiskPatientId = createRegularRiskPatient.payload.patient?.id;

  const createHighPriorityWaitlist = await requestJson('/api/v1/lista-espera', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      patient_id: highRiskPatientId,
      service_id: createdServiceId,
      establishment_id: 'cesfam-bauza',
      note: 'Sin cupo inicial para odontologia'
    })
  });
  assert(createHighPriorityWaitlist.status === 201, 'high priority waitlist create must succeed');
  highPriorityWaitlistId = createHighPriorityWaitlist.payload.waitlist_entry?.id;
  assert(createHighPriorityWaitlist.payload.waitlist_entry?.priority === 'riesgo_cronico', 'high risk waitlist must be tagged as riesgo_cronico');

  const createRegularPriorityWaitlist = await requestJson('/api/v1/lista-espera', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      patient_id: regularRiskPatientId,
      service_id: createdServiceId,
      establishment_id: 'cesfam-bauza',
      note: 'Espera preventiva sin riesgo cronico'
    })
  });
  assert(createRegularPriorityWaitlist.status === 201, 'regular priority waitlist create must succeed');
  regularPriorityWaitlistId = createRegularPriorityWaitlist.payload.waitlist_entry?.id;

  const duplicateWaitlist = await requestJson('/api/v1/lista-espera', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      patient_id: regularRiskPatientId,
      service_id: createdServiceId,
      establishment_id: 'cesfam-bauza',
      note: 'Intento duplicado'
    })
  });
  assert(duplicateWaitlist.status === 409, 'duplicate waitlist create must fail');

  const regularOfferBlocked = await requestJson(`/api/v1/lista-espera/${regularPriorityWaitlistId}/ofertas`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      slot_id: createdSlotId,
      note: 'No debe saltarse RL-01'
    })
  });
  assert(regularOfferBlocked.status === 409, 'lower priority waitlist offer must be blocked');
  assert(regularOfferBlocked.payload.recommended_waitlist_id === highPriorityWaitlistId, 'blocked offer must identify higher priority candidate');

  const createWaitlistOffer = await requestJson(`/api/v1/lista-espera/${highPriorityWaitlistId}/ofertas`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      slot_id: createdSlotId,
      note: 'Oferta temporal controlada R05'
    })
  });
  assert(createWaitlistOffer.status === 201, 'waitlist offer create must succeed');
  createdWaitlistOfferId = createWaitlistOffer.payload.offer?.id;
  assert(createWaitlistOffer.payload.waitlist_entry?.status === 'oferta_activa', 'waitlist entry must move to oferta_activa');

  const waitlistListBeforeRestart = await requestJson('/api/v1/lista-espera', {
    headers: authHeaders(gestorBearer)
  });
  assert(waitlistListBeforeRestart.status === 200, 'waitlist list must succeed');
  assert(waitlistListBeforeRestart.payload.items.some((item) => item.id === highPriorityWaitlistId && item.active_offer?.id === createdWaitlistOfferId), 'waitlist list must expose active offer');

  await delay(1200);
  const expired = await requestJson('/api/bootstrap', {
    headers: authHeaders(expiringBearer)
  });
  assert(expired.status === 401, 'expired session must return 401');
  assert(expired.payload.error === 'session_expired', 'expired session must expose session_expired');

  const logout = await requestJson('/api/auth/logout', {
    method: 'POST',
    headers: authHeaders(adminBearer)
  });
  assert(logout.status === 200, 'logout must return 200');

  const afterLogout = await requestJson('/api/bootstrap', { headers: authHeaders(adminBearer) });
  assert(afterLogout.status === 401, 'revoked session must return 401');

  await stopBackend(backend.child);
  backend = null;

  backend = startBackend();
  await waitForHealth();

  const persistedAppointment = await requestJson(`/api/v1/citas/${persistedAppointmentId}`, {
    headers: authHeaders(gestorBearer)
  });
  assert(persistedAppointment.status === 200, 'appointment detail must persist after restart');
  assert(persistedAppointment.payload.item?.status === 'agendada', 'persisted appointment must remain agendada after restart');

  const persistedAvailability = await requestJson('/api/v1/agendas/disponibilidad?establishment_id=cesfam-bauza&service_id=SV-003', {
    headers: authHeaders(gestorBearer)
  });
  assert(persistedAvailability.status === 200, 'availability after restart must succeed');
  assert(persistedAvailability.payload.items.some((item) => item.id === 'S-05') === false, 'reserved slot must not appear as available after restart');

  const waitlistAfterRestart = await requestJson('/api/v1/lista-espera', {
    headers: authHeaders(gestorBearer)
  });
  assert(waitlistAfterRestart.status === 200, 'waitlist list after restart must succeed');
  const persistedWaitlist = waitlistAfterRestart.payload.items.find((item) => item.id === highPriorityWaitlistId);
  assert(Boolean(persistedWaitlist), 'high priority waitlist entry must persist after restart');
  assert(persistedWaitlist.active_offer?.id === createdWaitlistOfferId, 'active waitlist offer must persist after restart');

  const waitlistOfferAccepted = await requestJson(`/api/v1/lista-espera/ofertas/${createdWaitlistOfferId}/resolver`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      resolution: 'aceptada',
      reason: 'Paciente acepta cupo ofertado'
    })
  });
  assert(waitlistOfferAccepted.status === 200, 'waitlist offer acceptance must succeed');
  assert(waitlistOfferAccepted.payload.waitlist_entry?.status === 'resuelta', 'accepted waitlist entry must become resuelta');
  assert(waitlistOfferAccepted.payload.appointment?.status === 'agendada', 'accepted waitlist offer must create appointment');

  const closeRegularWaitlist = await requestJson(`/api/v1/lista-espera/${regularPriorityWaitlistId}/cerrar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(gestorBearer)
    },
    body: JSON.stringify({
      reason: 'Paciente opta por otro canal de atencion'
    })
  });
  assert(closeRegularWaitlist.status === 200, 'waitlist close must succeed');
  assert(closeRegularWaitlist.payload.waitlist_entry?.status === 'cerrada', 'closed waitlist entry must become cerrada');

  const auditorAuditAfterWaitlist = await requestJson('/api/audit', { headers: authHeaders(auditorBearer) });
  assert(auditorAuditAfterWaitlist.status === 200, 'auditor audit after waitlist must work');
  assert(auditorAuditAfterWaitlist.payload.items.some((item) => item.action === 'waitlist.offer.create'), 'audit must record waitlist offer create');
  assert(auditorAuditAfterWaitlist.payload.items.some((item) => item.action === 'waitlist.offer.aceptada'), 'audit must record waitlist offer acceptance');
  assert(auditorAuditAfterWaitlist.payload.items.some((item) => item.action === 'waitlist.close'), 'audit must record waitlist close');

  const adminRelogin = await loginAs('admin.comunal', 'Quili.Admin!2026');
  assert(adminRelogin.status === 200, 'admin relogin before contactability must succeed');
  const adminContactBearer = adminRelogin.payload.auth.token;

  const contactTemplates = await requestJson('/api/v1/contactabilidad/plantillas', {
    headers: authHeaders(adminContactBearer)
  });
  assert(contactTemplates.status === 200, 'contact template list must succeed');
  const phoneTemplate = contactTemplates.payload.items.find((item) => item.code === 'TPL-CONTACT-01');
  const smsTemplate = contactTemplates.payload.items.find((item) => item.code === 'TPL-CONTACT-02');
  assert(Boolean(phoneTemplate), 'phone contact template must exist');
  assert(Boolean(smsTemplate), 'sms contact template must exist');

  const contactCreateDeniedForAuditor = await requestJson('/api/v1/contactabilidad/envios', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(auditorBearer)
    },
    body: JSON.stringify({
      patient_id: 'P-1001',
      template_id: phoneTemplate.id,
      purpose: 'recordatorio_cita',
      channel: 'telefono',
      detail: 'Contacto de prueba auditor'
    })
  });
  assert(contactCreateDeniedForAuditor.status === 403, 'auditor contact send must be denied');

  const blockedSensitiveSms = await requestJson('/api/v1/contactabilidad/envios', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(adminContactBearer)
    },
    body: JSON.stringify({
      patient_id: 'P-1001',
      template_id: smsTemplate.id,
      purpose: 'recordatorio_cita',
      channel: 'sms',
      detail: 'Incluye detalle sensible bloqueado',
      contains_sensitive_detail: true
    })
  });
  assert(blockedSensitiveSms.status === 422, 'sensitive sms send must be blocked');
  assert(blockedSensitiveSms.payload.error === 'sensitive_channel_blocked', 'blocked sensitive sms must be structured');

  const blockedNoContact = await requestJson('/api/v1/contactabilidad/envios', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(adminContactBearer)
    },
    body: JSON.stringify({
      patient_id: 'P-1003',
      template_id: phoneTemplate.id,
      purpose: 'recordatorio_cita',
      channel: 'telefono',
      detail: 'Paciente no contactable'
    })
  });
  assert(blockedNoContact.status === 409, 'blocked non-contactable patient must return 409');
  assert(blockedNoContact.payload.error === 'not_contactable', 'blocked non-contactable must be structured');

  const firstContactSend = await requestJson('/api/v1/contactabilidad/envios', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(adminContactBearer)
    },
    body: JSON.stringify({
      patient_id: 'P-1001',
      template_id: phoneTemplate.id,
      purpose: 'recordatorio_cita',
      channel: 'telefono',
      detail: 'Primer intento telefonico local'
    })
  });
  assert(firstContactSend.status === 201, 'first phone contact send must succeed');
  const contactCaseId = firstContactSend.payload.contact_case?.id;
  const firstMessageId = firstContactSend.payload.contact_message?.id;
  assert(Boolean(contactCaseId), 'contact send must return case id');

  const secondContactSend = await requestJson('/api/v1/contactabilidad/envios', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(adminContactBearer)
    },
    body: JSON.stringify({
      patient_id: 'P-1001',
      template_id: smsTemplate.id,
      purpose: 'recordatorio_cita',
      channel: 'sms',
      detail: 'Segundo intento sms local'
    })
  });
  assert(secondContactSend.status === 201, 'second sms contact send must succeed');

  const thirdContactSend = await requestJson('/api/v1/contactabilidad/envios', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(adminContactBearer)
    },
    body: JSON.stringify({
      patient_id: 'P-1001',
      template_id: phoneTemplate.id,
      purpose: 'recordatorio_cita',
      channel: 'telefono',
      detail: 'Tercer intento telefonico local'
    })
  });
  assert(thirdContactSend.status === 201, 'third phone contact send must succeed');
  const thirdMessageId = thirdContactSend.payload.contact_message?.id;

  const firstWebhook = await requestJson('/api/v1/contactabilidad/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(adminContactBearer)
    },
    body: JSON.stringify({
      message_id: firstMessageId,
      status: 'bounced',
      result: 'bounce',
      detail: 'Telefono sin respuesta'
    })
  });
  assert(firstWebhook.status === 200, 'contact webhook bounce must succeed');

  const thirdWebhook = await requestJson('/api/v1/contactabilidad/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(adminContactBearer)
    },
    body: JSON.stringify({
      message_id: thirdMessageId,
      status: 'escalated',
      result: 'escalated',
      detail: 'Requiere gestion humana local'
    })
  });
  assert(thirdWebhook.status === 200, 'contact webhook escalation must succeed');

  const closeContactCase = await requestJson(`/api/v1/contactabilidad/casos/${contactCaseId}/cerrar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(adminContactBearer)
    },
    body: JSON.stringify({
      closure_kind: 'no_contactable',
      reason: 'RL-05 completada tras tres intentos en dos canales'
    })
  });
  assert(closeContactCase.status === 200, 'contact case RL-05 close must succeed');
  assert(closeContactCase.payload.contact_case?.status === 'no_contactable', 'contact case must close as no_contactable');

  const contactInbox = await requestJson('/api/v1/contactabilidad/envios', {
    headers: authHeaders(adminContactBearer)
  });
  assert(contactInbox.status === 200, 'contact inbox list must succeed');
  const persistedContactCase = contactInbox.payload.cases.find((item) => item.id === contactCaseId);
  assert(Boolean(persistedContactCase), 'contact case must be listed');
  assert(persistedContactCase.attempt_count === 3, 'contact case must expose three attempts');

  const auditorAuditAfterContact = await requestJson('/api/audit', { headers: authHeaders(auditorBearer) });
  assert(auditorAuditAfterContact.status === 200, 'auditor audit after contactability must work');
  assert(auditorAuditAfterContact.payload.items.some((item) => item.action === 'contact.message.send'), 'audit must record contact send');
  assert(auditorAuditAfterContact.payload.items.some((item) => item.action === 'contact.message.result'), 'audit must record contact webhook result');
  assert(auditorAuditAfterContact.payload.items.some((item) => item.action === 'contact.case.close'), 'audit must record contact case close');

  const relogin = await loginAs('admin.comunal', 'Quili.Admin!2026');
  const reset = await requestJson('/api/demo/reset', {
    method: 'POST',
    headers: authHeaders(relogin.payload.auth.token)
  });
  assert(reset.status === 200, 'reset must succeed');
  assert(!reset.payload.bootstrap?.appointments.some((item) => item.id === persistedAppointmentId), 'reset must remove created persisted appointment');
  assert(!reset.payload.bootstrap?.professionals.some((item) => item.id === createdProfessionalId), 'reset must remove created professional');
  assert(!reset.payload.bootstrap?.waitlist.some((item) => item.id === highPriorityWaitlistId), 'reset must remove created waitlist entry');
  assert(!reset.payload.bootstrap?.patients.some((item) => item.id === highRiskPatientId), 'reset must remove created high risk patient');
  assert(!reset.payload.bootstrap?.contact_cases.some((item) => item.id === contactCaseId), 'reset must remove created contact case');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  if (backend?.stderrRef) {
    const stderr = backend.stderrRef();
    if (stderr) {
      console.error(stderr);
    }
  }
  process.exitCode = 1;
} finally {
  if (backend?.child) {
    await stopBackend(backend.child);
  }
}

if (!process.exitCode) {
  console.log('r08 v0025 verification pass');
}
