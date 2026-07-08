const nav = [
  ['dashboard', 'Portal Operativo'],
  ['agenda', 'Agenda'],
  ['patients', 'Pacientes'],
  ['waitlist', 'Lista espera'],
  ['contact', 'Contactabilidad'],
  ['campaigns', 'Campanas'],
  ['sidra', 'SIDRA'],
  ['reports', 'Reportes'],
  ['audit', 'Trazabilidad']
];

const queryApiBase = new URLSearchParams(location.search).get('e2e_api_base');
const apiBase = queryApiBase || globalThis.QUILICURA_API_BASE || (location.protocol === 'file:' || location.port === '4173' ? 'http://127.0.0.1:4310' : location.origin);
const authStorageKey = 'quilicura.session';
const rememberedUsernameKey = 'quilicura.lastUsername';
const state = {
  view: 'dashboard',
  query: '',
  agendaPanel: 'appointments',
  sortBy: {
    agenda: 'time',
    patients: 'name',
    waitlist: 'priority',
    contact: 'recent',
    sidra: 'status',
    audit: 'recent'
  },
  loading: false,
  resetting: false,
  loginPending: false,
  authMessage: '',
  actionMessage: null,
  health: null,
  bootstrap: null,
  auth: readAuth(),
  selectedPatientId: null,
  selectedAppointmentId: null,
  selectedWaitlistId: null,
  selectedContactCaseId: null,
  activeDrawer: null,
  activeModal: null,
  drawerTab: 'summary',
  e2eAttempted: false
};

const app = document.getElementById('app');
let actionMessageTimer = null;

function readAuth() {
  try {
    return JSON.parse(sessionStorage.getItem(authStorageKey) || 'null');
  } catch {
    return null;
  }
}

function writeAuth(value) {
  if (!value) {
    sessionStorage.removeItem(authStorageKey);
    return;
  }
  sessionStorage.setItem(authStorageKey, JSON.stringify(value));
}

function readRememberedUsername() {
  try {
    return localStorage.getItem(rememberedUsernameKey) || '';
  } catch {
    return '';
  }
}

function writeRememberedUsername(value) {
  try {
    if (!value) {
      localStorage.removeItem(rememberedUsernameKey);
      return;
    }
    localStorage.setItem(rememberedUsernameKey, String(value).trim().toLowerCase());
  } catch {
  }
}

function clearAuth(message = '') {
  state.auth = null;
  state.bootstrap = null;
  writeAuth(null);
  if (message) {
    state.authMessage = message;
  }
}

function setActionMessage(text, tone = 'pass') {
  if (actionMessageTimer) {
    clearTimeout(actionMessageTimer);
    actionMessageTimer = null;
  }
  state.actionMessage = text ? { text, tone } : null;
  if (text) {
    actionMessageTimer = setTimeout(() => {
      state.actionMessage = null;
      render();
    }, tone === 'denied' || tone === 'warn' ? 7000 : 4500);
  }
}

function badge(value) {
  const cls = String(value).toLowerCase().replaceAll(' ', '-').replaceAll('.', '-');
  return `<span class="badge ${cls}">${value}</span>`;
}

function cards(items) {
  return `<div class="cards">${items.map(([label, value, meta]) => `<article class="card metric"><span>${label}</span><strong>${value}</strong><small>${meta}</small></article>`).join('')}</div>`;
}

function rbac() {
  return state.bootstrap?.rbac || {
    permissions: [],
    allowed_establishments: [],
    view_access: {}
  };
}

function can(permission) {
  return rbac().permissions?.includes(permission);
}

function canView(view) {
  return Boolean(rbac().view_access?.[view]);
}

function currentViewLabel() {
  return nav.find(([id]) => id === state.view)?.[1] || 'Portal Operativo';
}

function preferredViewForRole(user, viewAccess = {}) {
  const candidates = {
    administrador_comunal: ['dashboard', 'patients', 'agenda'],
    gestor_cesfam: ['agenda', 'patients', 'waitlist'],
    profesional: ['agenda', 'patients', 'dashboard'],
    auditor: ['reports', 'audit', 'dashboard']
  }[user?.role] || ['dashboard'];

  return candidates.find((view) => viewAccess[view]) || 'dashboard';
}

function currentPatients() {
  return state.bootstrap?.patients || [];
}

function currentAppointments() {
  return state.bootstrap?.appointments || [];
}

function currentWaitlist() {
  return state.bootstrap?.waitlist || [];
}

function currentContactCases() {
  return state.bootstrap?.contact_cases || [];
}

function currentContactTemplates() {
  return state.bootstrap?.contact_templates || [];
}

function currentContactMessages() {
  return state.bootstrap?.contact_messages || [];
}

function currentSidraEvents() {
  return state.bootstrap?.sidra || [];
}

function selectedSidraEvent() {
  return currentSidraEvents().find((item) => item.id === state.activeDrawer?.id) || null;
}

function currentReports() {
  return state.bootstrap?.monthly_reports || [];
}

function currentBackups() {
  return state.bootstrap?.backups || [];
}

function compareText(left, right) {
  return String(left || '').localeCompare(String(right || ''), 'es', {
    numeric: true,
    sensitivity: 'base'
  });
}

function compareNumber(left, right) {
  return Number(left || 0) - Number(right || 0);
}

function compareDate(left, right) {
  return Date.parse(left || 0) - Date.parse(right || 0);
}

function sortRows(rows, mode, comparators) {
  const comparator = comparators[mode] || comparators.default;
  return [...rows].sort(comparator);
}

function currentSearchPlaceholder() {
  return {
    agenda: 'Buscar cupo, cita, profesional o establecimiento',
    patients: 'Buscar paciente, RUT, riesgo o establecimiento',
    waitlist: 'Buscar espera, paciente, prioridad o prestacion',
    contact: 'Buscar caso, paciente, finalidad o estado',
    sidra: 'Buscar evento, entidad, estado o establecimiento',
    audit: 'Buscar actor, accion, resultado o detalle'
  }[state.view] || 'Buscar en la vista actual';
}

function setViewSort(view, sortKey) {
  state.sortBy[view] = sortKey;
}

function sortHeader(view, sortKey, label) {
  const active = state.sortBy[view] === sortKey;
  return `<button class="sort-header ${active ? 'active' : ''}" type="button" data-sort-view="${view}" data-sort-key="${sortKey}">${label}${active ? ' ↑' : ''}</button>`;
}

function activeSessionKey() {
  return state.auth?.token || state.auth?.sessionKey || '';
}

function ensureSelectedPatient() {
  const patients = currentPatients();
  if (!patients.length) {
    state.selectedPatientId = null;
    return;
  }
  if (!patients.some((item) => item.id === state.selectedPatientId)) {
    state.selectedPatientId = patients[0].id;
  }
}

function ensureSelectedAppointment() {
  const appointments = currentAppointments();
  if (!appointments.length) {
    state.selectedAppointmentId = null;
    return;
  }
  if (!appointments.some((item) => item.id === state.selectedAppointmentId)) {
    state.selectedAppointmentId = appointments[0].id;
  }
}

function ensureSelectedWaitlist() {
  const entries = currentWaitlist();
  if (!entries.length) {
    state.selectedWaitlistId = null;
    return;
  }
  if (!entries.some((item) => item.id === state.selectedWaitlistId)) {
    state.selectedWaitlistId = entries[0].id;
  }
}

function ensureSelectedContactCase() {
  const cases = currentContactCases();
  if (!cases.length) {
    state.selectedContactCaseId = null;
    return;
  }
  if (!cases.some((item) => item.id === state.selectedContactCaseId)) {
    state.selectedContactCaseId = cases[0].id;
  }
}

function selectedPatient() {
  ensureSelectedPatient();
  return currentPatients().find((item) => item.id === state.selectedPatientId) || null;
}

function selectedAppointment() {
  ensureSelectedAppointment();
  return currentAppointments().find((item) => item.id === state.selectedAppointmentId) || null;
}

function selectedWaitlist() {
  ensureSelectedWaitlist();
  return currentWaitlist().find((item) => item.id === state.selectedWaitlistId) || null;
}

function selectedContactCase() {
  ensureSelectedContactCase();
  return currentContactCases().find((item) => item.id === state.selectedContactCaseId) || null;
}

function setAgendaPanel(panel) {
  state.agendaPanel = panel === 'availability' ? 'availability' : 'appointments';
}

function setDrawerTab(tab) {
  state.drawerTab = tab || 'summary';
}

function openDrawer(kind, id, tab = 'summary') {
  if (kind === 'appointment') {
    state.selectedAppointmentId = id;
  }
  if (kind === 'patient') {
    state.selectedPatientId = id;
  }
  if (kind === 'waitlist') {
    state.selectedWaitlistId = id;
  }
  if (kind === 'contact-case') {
    state.selectedContactCaseId = id;
  }
  state.activeDrawer = { kind, id };
  setDrawerTab(tab);
}

function closeDrawer() {
  state.activeDrawer = null;
  setDrawerTab('summary');
}

function openModal(kind, data = {}) {
  state.activeModal = { kind, ...data };
}

function closeModal() {
  state.activeModal = null;
}

async function request(path, options = {}, requiresAuth = true) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  const sessionKey = activeSessionKey();
  if (requiresAuth && sessionKey) {
    headers.Authorization = `Bearer ${sessionKey}`;
  }

  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (requiresAuth && ['auth_required', 'session_expired', 'user_inactive'].includes(payload.error)) {
      clearAuth(payload.message || 'Debes iniciar sesion nuevamente.');
      render();
    }
    const error = new Error(payload.message || payload.error || `${response.status} ${response.statusText}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

function applyBootstrap(payload) {
  state.bootstrap = payload.bootstrap || payload;
  ensureSelectedPatient();
  ensureSelectedAppointment();
  ensureSelectedWaitlist();
  ensureSelectedContactCase();
}

async function loadProtectedApp() {
  if (!activeSessionKey()) {
    state.bootstrap = null;
    render();
    return;
  }
  state.loading = true;
  state.authMessage = '';
  render();
  try {
    const [health, sessionSnapshot, bootstrap] = await Promise.all([
      request('/health', {}, false),
      request('/api/auth/session'),
      request('/api/bootstrap')
    ]);
    state.health = health;
    state.auth = {
      ...state.auth,
      expires_at: sessionSnapshot.session?.expires_at || state.auth?.expires_at,
      user: sessionSnapshot.user || state.auth?.user
    };
    state.bootstrap = bootstrap;
    ensureSelectedPatient();
    if (!canView(state.view) || state.view === 'dashboard') {
      state.view = preferredViewForRole(sessionSnapshot.user, bootstrap.rbac?.view_access || {});
    }
  } catch (error) {
    if (!state.authMessage) {
      state.authMessage = error.message;
    }
  } finally {
    state.loading = false;
    render();
  }
}

async function login(username, password) {
  const normalizedUsername = String(username || '').trim().toLowerCase();
  if (!normalizedUsername || !String(password || '').trim()) {
    state.authMessage = 'Debes ingresar usuario y contrasena.';
    render();
    return;
  }
  state.loginPending = true;
  state.authMessage = '';
  setActionMessage(null);
  render();
  try {
    const payload = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: normalizedUsername,
        password
      })
    }, false);
    state.auth = {
      token: payload.auth.token,
      expires_at: payload.auth.expires_at,
      user: payload.user
    };
    writeRememberedUsername(normalizedUsername);
    writeAuth(state.auth);
    await loadProtectedApp();
  } catch (error) {
    state.authMessage = error.message;
    render();
  } finally {
    state.loginPending = false;
    render();
  }
}

async function logout() {
  try {
    await request('/api/auth/logout', {
      method: 'POST'
    });
  } catch {
  }
  clearAuth('Sesion cerrada.');
  setActionMessage(null);
  render();
}

async function resetDemo() {
  state.resetting = true;
  setActionMessage(null);
  render();
  try {
    const payload = await request('/api/demo/reset', {
      method: 'POST'
    });
    state.auth = {
      token: payload.auth.token,
      expires_at: payload.auth.expires_at,
      user: payload.bootstrap.current_user
    };
    writeAuth(state.auth);
    applyBootstrap(payload);
    state.health = await request('/health', {}, false);
    setActionMessage(`Base local restaurada desde ${state.bootstrap?.runtime?.version || 'seed local'}.`, 'pass');
  } catch (error) {
    state.authMessage = error.message;
  } finally {
    state.resetting = false;
    render();
  }
}

async function blockSlot(slotId, reason) {
  try {
    const payload = await request(`/api/slots/${encodeURIComponent(slotId)}/block`, {
      method: 'POST',
      body: JSON.stringify({
        reason: reason || `Bloqueo manual desde UI por ${state.bootstrap?.current_user?.username || 'usuario'}`
      })
    });
    applyBootstrap(payload);
    closeModal();
    setActionMessage(payload.message || `Cupo ${slotId} bloqueado.`, 'pass');
  } catch (error) {
    setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
  } finally {
    render();
  }
}

async function createAppointment(data) {
  const payload = await request('/api/v1/citas', {
    method: 'POST',
    body: JSON.stringify({
      patient_id: data.get('patient_id'),
      slot_id: data.get('slot_id'),
      channel: data.get('channel'),
      note: data.get('note'),
      origin: 'ui_agenda_r04'
    })
  });
  applyBootstrap(payload);
  state.selectedAppointmentId = payload.appointment?.id || state.selectedAppointmentId;
  closeModal();
  openDrawer('appointment', state.selectedAppointmentId);
  setActionMessage(payload.message, 'pass');
  render();
}

async function confirmAppointment(appointmentId, data) {
  const payload = await request(`/api/v1/citas/${encodeURIComponent(appointmentId)}/confirmacion`, {
    method: 'PATCH',
    body: JSON.stringify({
      channel: data.get('channel') || 'telefono'
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

async function cancelAppointment(appointmentId, data) {
  const payload = await request(`/api/v1/citas/${encodeURIComponent(appointmentId)}/cancelar`, {
    method: 'POST',
    body: JSON.stringify({
      reason: data.get('reason')
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

async function rescheduleAppointment(appointmentId, data) {
  const payload = await request(`/api/v1/citas/${encodeURIComponent(appointmentId)}/reprogramar`, {
    method: 'POST',
    body: JSON.stringify({
      new_slot_id: data.get('new_slot_id'),
      reason: data.get('reason')
    })
  });
  applyBootstrap(payload);
  state.selectedAppointmentId = payload.appointment?.id || state.selectedAppointmentId;
  setActionMessage(payload.message, 'pass');
  render();
}

function filteredPatients() {
  const rows = currentPatients();
  const query = state.query.trim().toLowerCase();
  const filtered = !query ? rows : rows.filter((item) => [
    item.display_name,
    item.legal_name,
    item.rut,
    item.sector,
    item.risk,
    item.establishment_name
  ].some((value) => String(value || '').toLowerCase().includes(query)));
  return sortRows(filtered, state.sortBy.patients, {
    default: (left, right) => compareText(left.display_name, right.display_name),
    name: (left, right) => compareText(left.display_name, right.display_name),
    id: (left, right) => compareText(left.id, right.id),
    age: (left, right) => compareNumber(right.age, left.age),
    risk: (left, right) => compareText(left.risk, right.risk)
  });
}

function filteredAgendaSlots() {
  const rows = currentAppointments();
  const query = state.query.trim().toLowerCase();
  const slots = state.bootstrap?.slots || [];
  const filtered = !query ? slots : slots.filter((slot) => [
    slot.id,
    slot.service,
    slot.service_name,
    slot.professional,
    slot.professional_name,
    slot.establishment_name,
    slot.day,
    slot.time
  ].some((value) => String(value || '').toLowerCase().includes(query)));
  return sortRows(filtered, state.sortBy.agenda, {
    default: (left, right) => compareDate(left.starts_at, right.starts_at) || compareText(left.id, right.id),
    time: (left, right) => compareDate(left.starts_at, right.starts_at) || compareText(left.id, right.id),
    id: (left, right) => compareText(left.id, right.id),
    patient: (left, right) => compareText(left.professional_name || left.professional, right.professional_name || right.professional),
    status: (left, right) => compareText(left.status, right.status) || compareDate(left.starts_at, right.starts_at)
  });
}

function filteredAppointments() {
  const rows = currentAppointments();
  const query = state.query.trim().toLowerCase();
  const filtered = !query ? rows : rows.filter((item) => [
    item.id,
    item.patient_name,
    item.service_name,
    item.slot_label,
    item.status
  ].some((value) => String(value || '').toLowerCase().includes(query)));
  return sortRows(filtered, state.sortBy.agenda, {
    default: (left, right) => compareDate(left.starts_at, right.starts_at) || compareText(left.id, right.id),
    time: (left, right) => compareDate(left.starts_at, right.starts_at) || compareText(left.id, right.id),
    id: (left, right) => compareText(left.id, right.id),
    patient: (left, right) => compareText(left.patient_name, right.patient_name),
    status: (left, right) => compareText(left.status, right.status) || compareDate(left.starts_at, right.starts_at)
  });
}

function sessionExpiresText() {
  if (!state.auth?.expires_at) {
    return 'Sin sesion';
  }
  return new Date(state.auth.expires_at).toLocaleString('es-CL', {
    hour12: false
  });
}

function scopeList() {
  const items = rbac().allowed_establishments || [];
  if (!items.length) {
    return 'Sin establecimientos asignados';
  }
  return items.map((item) => item.name).join(' · ');
}

function deniedView() {
  return `
    <section class="card denied-panel">
      <div class="section-head"><h2>Modulo bloqueado</h2>${badge('permission_denied')}</div>
      <p>El rol actual no tiene permiso para abrir <strong>${currentViewLabel()}</strong>.</p>
      <ul class="plain-list">
        <li>Rol actual: ${rbac().role?.label || state.bootstrap?.current_user?.role || 'Sin rol'}.</li>
        <li>Alcance activo: ${scopeList()}.</li>
        <li>La API aplica el mismo bloqueo con <code>403</code> estructurado.</li>
      </ul>
    </section>
  `;
}

function patientAgeLabel(patient) {
  return patient.age ?? '-';
}

function selectedOption(currentValue, optionValue) {
  return currentValue === optionValue ? 'selected' : '';
}

function checked(value) {
  return value ? 'checked' : '';
}

function availableSlots() {
  return (state.bootstrap?.slots || []).filter((slot) => slot.status === 'disponible');
}

function detailTabs(items) {
  return `<div class="detail-tabs" role="tablist">${items.map(([id, label]) => `
    <button class="detail-tab ${state.drawerTab === id ? 'active' : ''}" type="button" data-drawer-tab="${id}" role="tab" aria-selected="${state.drawerTab === id}">
      ${label}
    </button>
  `).join('')}</div>`;
}

function tabPanel(id, content) {
  return `<section class="detail-panel ${state.drawerTab === id ? '' : 'is-hidden'}" data-tab-panel="${id}">${content}</section>`;
}

function drawerShell(title, tone, content, attrs = '') {
  return `
    <div class="overlay-shell" data-overlay-root>
      <button class="overlay-backdrop" type="button" data-close-overlay aria-label="Cerrar panel"></button>
      <aside class="drawer-panel" ${attrs}>
        <header class="drawer-head">
          <div>
            <p class="eyebrow">Detalle</p>
            <h2>${title}</h2>
          </div>
          <div class="drawer-actions">
            ${badge(tone)}
            <button class="slot-action secondary" type="button" data-close-overlay>Cerrar</button>
          </div>
        </header>
        <div class="drawer-body">${content}</div>
      </aside>
    </div>
  `;
}

function modalShell(title, content, attrs = '') {
  return `
    <div class="overlay-shell" data-overlay-root>
      <button class="overlay-backdrop" type="button" data-close-overlay aria-label="Cerrar modal"></button>
      <section class="modal-panel" ${attrs}>
        <header class="drawer-head">
          <div>
            <p class="eyebrow">Accion</p>
            <h2>${title}</h2>
          </div>
          <button class="slot-action secondary" type="button" data-close-overlay>Cerrar</button>
        </header>
        <div class="drawer-body">${content}</div>
      </section>
    </div>
  `;
}

function compactSummaryCards(items) {
  return `<div class="cards compact-cards">${items.map(([label, value, meta]) => `
    <article class="card metric compact-metric">
      <span>${label}</span>
      <strong>${value}</strong>
      <small>${meta}</small>
    </article>
  `).join('')}</div>`;
}

function appointmentDetailCard(appointment) {
  if (!appointment) {
    return '';
  }
  const manageable = appointment.allowed_actions?.cancel || appointment.allowed_actions?.reprogram || appointment.allowed_actions?.confirm;
  const rescheduleOptions = availableSlots().filter((slot) => slot.id !== appointment.slotId && slot.establishment_id === appointment.establishment_id);
  return drawerShell('Gestion de cita', appointment.status, `
      <section class="card detail-card">
      <div class="section-head"><h3>Resumen</h3>${badge(appointment.status)}</div>
      <ul class="plain-list">
        <li>Paciente: <strong>${appointment.patient_name}</strong>.</li>
        <li>Prestacion: ${appointment.service_name || 'Sin prestacion'}.</li>
        <li>Profesional: ${appointment.professional_name || 'Sin profesional'}.</li>
        <li>Cupo: ${appointment.slot_label}.</li>
      </ul>
      <div class="grid two">
        <form id="confirm-appointment-form" class="form-grid">
          <label>Canal confirmacion
            <select name="channel" ${appointment.allowed_actions?.confirm ? '' : 'disabled'}>
              ${['telefono', 'sms', 'correo', 'meson'].map((item) => `<option value="${item}" ${selectedOption(appointment.channel, item)}>${item}</option>`).join('')}
            </select>
          </label>
          <div class="form-actions span-2">
            <button type="submit" ${appointment.allowed_actions?.confirm ? '' : 'disabled'}>Confirmar cita</button>
          </div>
        </form>
        <form id="cancel-appointment-form" class="form-grid">
          <label class="span-2">Causal cancelacion<input name="reason" placeholder="Solicitud del paciente" ${appointment.allowed_actions?.cancel ? '' : 'disabled'}></label>
          <div class="form-actions span-2">
            <button type="submit" ${appointment.allowed_actions?.cancel ? '' : 'disabled'}>Cancelar cita</button>
          </div>
        </form>
      </div>
      <form id="reschedule-appointment-form" class="form-grid">
        <label>Nuevo cupo
          <select name="new_slot_id" ${appointment.allowed_actions?.reprogram ? '' : 'disabled'}>
            <option value="">Selecciona cupo</option>
            ${rescheduleOptions.map((slot) => `<option value="${slot.id}">${slot.slot_label || `${slot.day} ${slot.time}`} · ${slot.service_name || slot.service}</option>`).join('')}
          </select>
        </label>
        <label class="span-2">Causal reprogramacion<input name="reason" placeholder="Contingencia local" ${appointment.allowed_actions?.reprogram ? '' : 'disabled'}></label>
        <div class="form-actions span-2">
          <button type="submit" ${appointment.allowed_actions?.reprogram ? '' : 'disabled'}>Reprogramar cita</button>
          <span class="inline-note">${manageable ? 'La reprogramacion y cancelacion quedan registradas en el historial.' : 'Solo lectura.'}</span>
        </div>
      </form>
    </section>
    <section class="card detail-card">
      <div class="section-head"><h3>Historial</h3>${badge((appointment.history || []).length)}</div>
      <table><thead><tr><th>Fecha</th><th>Accion</th><th>Desde</th><th>Hacia</th><th>Detalle</th></tr></thead><tbody>${(appointment.history || []).map((item) => `<tr><td>${item.at}</td><td>${item.action}</td><td>${item.from_status || '-'}</td><td>${item.to_status || '-'}</td><td>${item.detail || ''}</td></tr>`).join('')}</tbody></table>
    </section>
  `, 'data-drawer-kind="appointment"');
}

function patientDetailCard(patient) {
  if (!patient) {
    return '';
  }
  const manage = can('patients.write') && patient.allowed_actions?.manage;
  return drawerShell(`Ficha administrativa · ${patient.display_name}`, patient.status, `
    ${detailTabs([
      ['summary', 'Ficha'],
      ['contacts', 'Contactos'],
      ['network', 'Representantes'],
      ['consents', 'Consentimientos']
    ])}
    ${tabPanel('summary', `
    <section class="card detail-card">
      <div class="section-head"><h3>Ficha administrativa</h3>${badge(patient.status)}</div>
      <form id="edit-patient-form" class="form-grid">
        <input type="hidden" name="patient_id" value="${patient.id}">
        <label>RUT<input name="rut" value="${patient.rut || ''}" ${manage ? '' : 'disabled'}></label>
        <label>Tipo identificador
          <select name="identifier_kind" ${manage ? '' : 'disabled'}>
            <option value="definitive" ${selectedOption(patient.identifier_kind, 'definitive')}>Definitivo</option>
            <option value="transient" ${selectedOption(patient.identifier_kind, 'transient')}>Transitorio</option>
          </select>
        </label>
        <label>Nombre legal<input name="legal_name" value="${patient.legal_name || ''}" ${manage ? '' : 'disabled'}></label>
        <label>Nombre social<input name="social_name" value="${patient.social_name || ''}" ${manage ? '' : 'disabled'}></label>
        <label>Fecha nacimiento<input name="birth_date" type="date" value="${patient.birth_date || ''}" ${manage ? '' : 'disabled'}></label>
        <label>Estado
          <select name="status" ${manage ? '' : 'disabled'}>
            ${['activo', 'pendiente_validacion', 'inactivo', 'fallecido', 'fusionado'].map((item) => `<option value="${item}" ${selectedOption(patient.status, item)}>${item}</option>`).join('')}
          </select>
        </label>
        <label>Establecimiento
          <select name="establishment_id" ${manage ? '' : 'disabled'}>
            ${(state.bootstrap.establishments || []).map((item) => `<option value="${item.id}" ${selectedOption(patient.establishment_id, item.id)}>${item.name}</option>`).join('')}
          </select>
        </label>
        <label>Sector<input name="sector" value="${patient.sector || ''}" ${manage ? '' : 'disabled'}></label>
        <label>Riesgo<input name="risk" value="${patient.risk || ''}" ${manage ? '' : 'disabled'}></label>
        <label class="span-2">Notas<textarea name="notes" ${manage ? '' : 'disabled'}>${patient.notes || ''}</textarea></label>
        <label class="span-2">Motivo cierre logico<textarea name="closure_reason" ${manage ? '' : 'disabled'} placeholder="Obligatorio si cambias el estado fuera de activo"></textarea></label>
        <div class="form-actions span-2">
          <button type="submit" ${manage ? '' : 'disabled'}>Guardar ficha</button>
          <span class="inline-note">${manage ? 'Los cambios quedan guardados de inmediato.' : 'Tu rol solo tiene lectura.'}</span>
        </div>
      </form>
    </section>
    `)}
    ${tabPanel('contacts', `
    <section class="card detail-card">
      <div class="section-head"><h3>Contactos</h3>${badge(patient.contacts.length)}</div>
      <div class="stack compact">${patient.contacts.map((contact) => `
        <article class="stack-card">
          <div>
            <strong>${contact.label}</strong>
            <span>${contact.type} · ${contact.channel} · ${contact.value}</span>
            <small>${contact.verified ? 'Verificado' : 'Pendiente'} · ${contact.active ? 'Activo' : 'Inactivo'}</small>
          </div>
          <div class="slot-actions">
            ${badge(contact.excluded_from_non_urgent ? 'excluido' : 'vigente')}
            ${manage ? `<button class="slot-action secondary" data-toggle-contact="${contact.id}" data-contact-state="${contact.excluded_from_non_urgent ? 'include' : 'exclude'}">${contact.excluded_from_non_urgent ? 'Rehabilitar' : 'Excluir no urgente'}</button>` : ''}
          </div>
        </article>
      `).join('')}</div>
      <form id="add-contact-form" class="form-grid">
        <input type="hidden" name="patient_id" value="${patient.id}">
        <label>Tipo
          <select name="type" ${manage ? '' : 'disabled'}>
            <option value="telefono">telefono</option>
            <option value="correo">correo</option>
            <option value="domicilio">domicilio</option>
            <option value="otro">otro</option>
          </select>
        </label>
        <label>Canal
          <select name="channel" ${manage ? '' : 'disabled'}>
            <option value="telefono">telefono</option>
            <option value="sms">sms</option>
            <option value="whatsapp">whatsapp</option>
            <option value="correo">correo</option>
            <option value="domicilio">domicilio</option>
            <option value="otro">otro</option>
          </select>
        </label>
        <label>Etiqueta<input name="label" placeholder="Principal" ${manage ? '' : 'disabled'}></label>
        <label>Valor<input name="value" placeholder="+56 9 4000 9999" ${manage ? '' : 'disabled'}></label>
        <label>Fuente<input name="source" value="gestion_ui" ${manage ? '' : 'disabled'}></label>
        <label class="inline-check"><input type="checkbox" name="verified" ${manage ? '' : 'disabled'}>Verificado</label>
        <div class="form-actions span-2">
          <button type="submit" ${manage ? '' : 'disabled'}>Agregar contacto</button>
        </div>
      </form>
    </section>
    `)}
    ${tabPanel('network', `
    <section class="card detail-card">
      <div class="section-head"><h3>Representantes</h3>${badge(patient.representatives.length)}</div>
      <div class="stack compact">${patient.representatives.map((representative) => `
        <article class="stack-card">
          <div>
            <strong>${representative.legal_name}</strong>
            <span>${representative.relation} · ${representative.phone || 'Sin telefono'}</span>
            <small>${representative.verified ? 'Verificado' : 'No verificado'} · ${representative.status}</small>
          </div>
          <div class="slot-actions">
            ${badge(representative.status)}
            ${manage && !representative.verified ? `<button class="slot-action secondary" data-verify-representative="${representative.id}">Marcar verificado</button>` : ''}
          </div>
        </article>
      `).join('')}</div>
      <form id="add-representative-form" class="form-grid">
        <input type="hidden" name="patient_id" value="${patient.id}">
        <label>Nombre legal<input name="legal_name" ${manage ? '' : 'disabled'}></label>
        <label>Relacion<input name="relation" placeholder="Madre, hijo, cuidador" ${manage ? '' : 'disabled'}></label>
        <label>Telefono<input name="phone" placeholder="+56 9 4000 7777" ${manage ? '' : 'disabled'}></label>
        <label class="inline-check"><input type="checkbox" name="verified" ${manage ? '' : 'disabled'}>Verificado</label>
        <label class="span-2">Notas<textarea name="notes" ${manage ? '' : 'disabled'}></textarea></label>
        <div class="form-actions span-2">
          <button type="submit" ${manage ? '' : 'disabled'}>Agregar representante</button>
        </div>
      </form>
    </section>
    `)}
    ${tabPanel('consents', `
    <section class="card detail-card">
      <div class="section-head"><h3>Preferencias y consentimientos</h3>${badge(patient.preferences.language || 'espanol')}</div>
      <form id="update-preferences-form" class="form-grid">
        <input type="hidden" name="patient_id" value="${patient.id}">
        <label>Canal preferido
          <select name="preferred_channel" ${manage ? '' : 'disabled'}>
            <option value="">Sin preferencia</option>
            ${['telefono', 'sms', 'whatsapp', 'correo', 'domicilio', 'otro'].map((item) => `<option value="${item}" ${selectedOption(patient.preferences.preferred_channel, item)}>${item}</option>`).join('')}
          </select>
        </label>
        <label>Idioma
          <select name="language" ${manage ? '' : 'disabled'}>
            ${['espanol', 'creole', 'otro'].map((item) => `<option value="${item}" ${selectedOption(patient.preferences.language, item)}>${item}</option>`).join('')}
          </select>
        </label>
        <label class="span-2 inline-check"><input type="checkbox" name="allow_non_urgent" ${checked(patient.preferences.allow_non_urgent)} ${manage ? '' : 'disabled'}>Permitir comunicaciones no urgentes</label>
        <label class="span-2">Notas preferencias<textarea name="notes" ${manage ? '' : 'disabled'}>${patient.preferences.notes || ''}</textarea></label>
        <div class="form-actions span-2">
          <button type="submit" ${manage ? '' : 'disabled'}>Guardar preferencias</button>
        </div>
      </form>
      <div class="stack compact">${patient.consents.map((consent) => `
        <article class="stack-card">
          <div>
            <strong>${consent.purpose}</strong>
            <span>${(consent.channel_scope || []).join(', ') || 'Sin canales'}</span>
            <small>${consent.status} · ${consent.granted_at || 'sin fecha'}</small>
          </div>
          <div class="slot-actions">
            ${badge(consent.status)}
            ${manage && consent.status === 'vigente' ? `<button class="slot-action secondary" data-revoke-consent="${consent.id}">Revocar</button>` : ''}
          </div>
        </article>
      `).join('')}</div>
      <form id="add-consent-form" class="form-grid">
        <input type="hidden" name="patient_id" value="${patient.id}">
        <label>Finalidad<input name="purpose" placeholder="recordatorio_cita" ${manage ? '' : 'disabled'}></label>
        <label>Canales<input name="channel_scope" placeholder="sms,telefono" ${manage ? '' : 'disabled'}></label>
        <label>Fuente<input name="source" value="gestion_ui" ${manage ? '' : 'disabled'}></label>
        <label class="inline-check"><input type="checkbox" name="granted" checked ${manage ? '' : 'disabled'}>Vigente</label>
        <label class="span-2">Notas<textarea name="notes" ${manage ? '' : 'disabled'}></textarea></label>
        <div class="form-actions span-2">
          <button type="submit" ${manage ? '' : 'disabled'}>Agregar consentimiento</button>
        </div>
      </form>
    </section>
    `)}
  `, 'data-drawer-kind="patient"');
}

function waitlistDetailCard(entry) {
  if (!entry) {
    return '';
  }
  const writeEnabled = can('waitlist.write');
  const offerSlots = waitlistOfferableSlots(entry);
  return drawerShell(`Gestion de espera · ${entry.patient_name}`, entry.status, `
    ${detailTabs([
      ['summary', 'Resumen'],
      ['offer', 'Oferta'],
      ['events', 'Eventos']
    ])}
    ${tabPanel('summary', `
    <section class="card detail-card">
      <div class="section-head"><h3>Gestion de espera</h3>${badge(entry.status)}</div>
      <ul class="plain-list">
        <li>Paciente: <strong>${entry.patient_name}</strong>.</li>
        <li>Prestacion: ${entry.service}.</li>
        <li>Prioridad aplicada: ${entry.priority} por ${entry.priority_rule}.</li>
        <li>Antiguedad: ${entry.requested_days} dias.</li>
      </ul>
      <div class="grid two">
        <form id="offer-waitlist-form" class="form-grid">
          <label>Cupo a ofertar
            <select name="slot_id" ${entry.allowed_actions?.offer ? '' : 'disabled'}>
              <option value="">Selecciona cupo</option>
              ${offerSlots.map((slot) => `<option value="${slot.id}">${slot.day} ${slot.time} · ${slot.establishment_name}</option>`).join('')}
            </select>
          </label>
          <label class="span-2">Nota de oferta<input name="note" placeholder="Reserva temporal controlada" ${entry.allowed_actions?.offer ? '' : 'disabled'}></label>
          <div class="form-actions span-2">
            <button type="submit" ${entry.allowed_actions?.offer ? '' : 'disabled'}>Crear oferta temporal</button>
            <span class="inline-note">${writeEnabled ? 'La oferta se revisa manualmente antes de asignar un cupo.' : 'Solo lectura para tu rol.'}</span>
          </div>
        </form>
        <form id="close-waitlist-form" class="form-grid">
          <label class="span-2">Motivo de cierre<input name="reason" placeholder="Resuelto por otro canal" ${entry.allowed_actions?.close ? '' : 'disabled'}></label>
          <div class="form-actions span-2">
            <button type="submit" ${entry.allowed_actions?.close ? '' : 'disabled'}>Cerrar espera</button>
          </div>
        </form>
      </div>
    </section>
    `)}
    ${tabPanel('offer', `
    <section class="card detail-card">
      <div class="section-head"><h3>Oferta activa</h3>${badge(entry.active_offer?.status || 'sin_oferta')}</div>
      ${entry.active_offer ? `
        <ul class="plain-list">
          <li>Oferta: <strong>${entry.active_offer.id}</strong>.</li>
          <li>Cupo reservado: ${entry.active_offer.slot_label}.</li>
          <li>Expira: ${new Date(entry.active_offer.expires_at).toLocaleString('es-CL', { hour12: false })}.</li>
        </ul>
        <form id="resolve-waitlist-offer-form" class="form-grid" data-offer-id="${entry.active_offer.id}">
          <label>Resolucion
            <select name="resolution" ${entry.allowed_actions?.resolve_offer ? '' : 'disabled'}>
              <option value="aceptada">aceptada</option>
              <option value="rechazada">rechazada</option>
            </select>
          </label>
          <label class="span-2">Detalle<input name="reason" placeholder="Paciente acepta o rechaza oferta" ${entry.allowed_actions?.resolve_offer ? '' : 'disabled'}></label>
          <div class="form-actions span-2">
            <button type="submit" ${entry.allowed_actions?.resolve_offer ? '' : 'disabled'}>Resolver oferta</button>
          </div>
        </form>
      ` : '<p class="muted">No hay oferta pendiente para esta necesidad.</p>'}
    </section>
    `)}
    ${tabPanel('events', `
    <section class="card detail-card">
      <div class="section-head"><h3>Eventos de espera</h3>${badge((entry.events || []).length)}</div>
      <table><thead><tr><th>Fecha</th><th>Evento</th><th>Regla</th><th>Detalle</th></tr></thead><tbody>${(entry.events || []).map((item) => `<tr><td>${item.at}</td><td>${item.type}</td><td>${item.rule_applied || '-'}</td><td>${item.detail || ''}</td></tr>`).join('')}</tbody></table>
    </section>
    `)}
  `, 'data-drawer-kind="waitlist"');
}

function contactCaseDetailCard(contactCase) {
  if (!contactCase) {
    return '';
  }
  const latestMessage = contactCase.attempts?.[0] || null;
  return drawerShell(`Caso de contactabilidad · ${contactCase.patient_name}`, contactCase.status, `
    ${detailTabs([
      ['summary', 'Resumen'],
      ['timeline', 'Intentos'],
      ['actions', 'Resolucion']
    ])}
    ${tabPanel('summary', `
      <section class="card detail-card">
        <div class="section-head"><h3>Resumen del caso</h3>${badge(contactCase.status)}</div>
        <ul class="plain-list">
          <li>Paciente: <strong>${contactCase.patient_name}</strong>.</li>
          <li>Finalidad: ${contactCase.purpose}.</li>
          <li>Intentos: ${contactCase.attempt_count} por ${contactCase.channel_count} canales.</li>
          <li>Establecimiento: ${contactCase.establishment_name}.</li>
        </ul>
      </section>
    `)}
    ${tabPanel('timeline', `
      <section class="card detail-card">
        <div class="section-head"><h3>Timeline de intentos</h3>${badge((contactCase.attempts || []).length)}</div>
        <table><thead><tr><th>Fecha</th><th>Canal</th><th>Estado</th><th>Resultado</th><th>Detalle</th></tr></thead><tbody>${(contactCase.attempts || []).map((item) => `<tr><td>${item.created_at}</td><td>${item.channel}</td><td>${badge(item.status)}</td><td>${item.result || '-'}</td><td>${item.preview || item.result_detail || ''}</td></tr>`).join('')}</tbody></table>
      </section>
    `)}
    ${tabPanel('actions', `
      <section class="card detail-card">
        <div class="section-head"><h3>Registrar resultado</h3>${badge(can('contact.write') ? 'contact.write' : 'solo_lectura')}</div>
        <form id="resolve-contact-message-form" class="form-grid">
          <label>Mensaje
            <select name="message_id" ${can('contact.write') ? '' : 'disabled'}>
              ${(contactCase.attempts || []).map((item) => `<option value="${item.id}" ${latestMessage?.id === item.id ? 'selected' : ''}>${item.id} · ${item.channel}</option>`).join('')}
            </select>
          </label>
          <label>Estado
            <select name="status" ${can('contact.write') ? '' : 'disabled'}>
              ${['delivered', 'responded', 'bounced', 'failed', 'escalated'].map((item) => `<option value="${item}">${item}</option>`).join('')}
            </select>
          </label>
          <label>Resultado
            <select name="result" ${can('contact.write') ? '' : 'disabled'}>
              ${['success', 'bounce', 'failed', 'no_response', 'escalated'].map((item) => `<option value="${item}">${item}</option>`).join('')}
            </select>
          </label>
          <label class="span-2">Detalle resultado<input name="detail" placeholder="Respuesta, rebote o escalamiento" ${can('contact.write') ? '' : 'disabled'}></label>
          <div class="form-actions span-2">
            <button type="submit" ${can('contact.write') ? '' : 'disabled'}>Registrar resultado</button>
          </div>
        </form>
        <form id="close-contact-case-form" class="form-grid">
          <label>Tipo cierre
            <select name="closure_kind" ${contactCase.allowed_actions?.close_no_contact ? '' : 'disabled'}>
              <option value="no_contactable">no_contactable</option>
              <option value="manual_resolution">manual_resolution</option>
            </select>
          </label>
          <label class="span-2">Motivo cierre<input name="reason" placeholder="Cierre manual con auditoria" ${contactCase.allowed_actions?.close_no_contact ? '' : 'disabled'}></label>
          <div class="form-actions span-2">
            <button type="submit" ${contactCase.allowed_actions?.close_no_contact ? '' : 'disabled'}>Cerrar caso</button>
            <span class="inline-note">El cierre exige intentos suficientes y registro completo del caso.</span>
          </div>
        </form>
      </section>
    `)}
  `, 'data-drawer-kind="contact-case"');
}

function sidraDetailCard(event) {
  if (!event) {
    return '';
  }
  const canManage = rbac().action_access?.sidra_manage;
  const hasActions = event.allowed_actions?.process || event.allowed_actions?.retry || event.allowed_actions?.resolve_discrepancy;
  return drawerShell(`Gestion SIDRA · ${event.id}`, event.status, `
    ${detailTabs([
      ['summary', 'Resumen'],
      ['actions', 'Acciones'],
      ['history', 'Seguimiento']
    ])}
    ${tabPanel('summary', `
      <section class="card detail-card">
        <div class="section-head"><h3>Resumen del evento</h3>${badge(event.status)}</div>
        <ul class="plain-list">
          <li>Evento: <strong>${event.type}</strong>.</li>
          <li>Entidad: ${event.entity} ${event.entity_id ? `· ${event.entity_id}` : ''}.</li>
          <li>Establecimiento: ${event.establishment_name}.</li>
          <li>Reintentos: ${event.retries}/${event.max_retries}.</li>
        </ul>
        <p class="muted">${event.last_error || event.discrepancy_note || 'Sin alertas activas para este evento.'}</p>
      </section>
    `)}
    ${tabPanel('actions', `
      <section class="card detail-card">
        <div class="section-head"><h3>Acciones disponibles</h3>${badge(canManage ? 'gestion_habilitada' : 'solo_lectura')}</div>
        <p class="muted">${canManage ? 'La operacion del evento se concentra en este panel para evitar ruido en la tabla.' : 'Tu rol puede revisar el seguimiento, pero no ejecutar acciones.'}</p>
        ${event.allowed_actions?.process ? `
          <form id="sidra-process-form" class="form-grid">
            <label>Resultado
              <select name="result">
                ${['acknowledged', 'failed', 'rejected', 'discrepancy'].map((value) => `<option value="${value}">${value}</option>`).join('')}
              </select>
            </label>
            <label>Codigo de error<input name="error_code" placeholder="SIDRA_ERR"></label>
            <label class="span-2">Detalle<input name="detail" value="Procesamiento manual ${event.id}"></label>
            <div class="form-actions span-2">
              <button type="submit">Procesar evento</button>
            </div>
          </form>
        ` : ''}
        ${event.allowed_actions?.retry ? `
          <form id="sidra-retry-form" class="form-grid">
            <label class="span-2">Detalle<input name="detail" value="Reintento manual ${event.id}"></label>
            <div class="form-actions span-2">
              <button type="submit">Marcar reintento</button>
            </div>
          </form>
        ` : ''}
        ${event.allowed_actions?.resolve_discrepancy ? `
          <form id="sidra-resolve-form" class="form-grid">
            <label class="span-2">Resolucion<input name="resolution_note" value="Conciliacion manual ${event.id}"></label>
            <div class="form-actions span-2">
              <button type="submit">Resolver discrepancia</button>
            </div>
          </form>
        ` : ''}
        ${!hasActions ? '<p class="muted">No hay acciones pendientes para este evento.</p>' : ''}
      </section>
    `)}
    ${tabPanel('history', `
      <section class="card detail-card">
        <div class="section-head"><h3>Seguimiento</h3>${badge(event.status)}</div>
        <ul class="plain-list">
          <li>Creado: ${event.created_at || '-'}</li>
          <li>Ultima actualizacion: ${event.updated_at || event.created_at || '-'}</li>
          <li>Resultado esperado: ${event.simulation_default_result || '-'}</li>
          <li>Detalle visible: ${event.last_error || event.discrepancy_note || 'Sin observaciones'}</li>
        </ul>
      </section>
    `)}
  `, 'data-drawer-kind="sidra"');
}

function renderActiveDrawer() {
  const drawer = state.activeDrawer;
  if (!drawer) {
    return '';
  }
  if (drawer.kind === 'appointment') {
    return appointmentDetailCard(selectedAppointment());
  }
  if (drawer.kind === 'patient') {
    return patientDetailCard(selectedPatient());
  }
  if (drawer.kind === 'waitlist') {
    return waitlistDetailCard(selectedWaitlist());
  }
  if (drawer.kind === 'contact-case') {
    return contactCaseDetailCard(selectedContactCase());
  }
  if (drawer.kind === 'sidra') {
    return sidraDetailCard(selectedSidraEvent());
  }
  return '';
}

function renderActiveModal() {
  const modal = state.activeModal;
  if (!modal) {
    return '';
  }
  if (modal.kind === 'patient-create') {
    return modalShell('Nuevo paciente', `
      <form id="create-patient-form" class="form-grid">
        <label>RUT<input name="rut" placeholder="55.555.555-5" ${can('patients.write') ? '' : 'disabled'}></label>
        <label>Tipo identificador
          <select name="identifier_kind" ${can('patients.write') ? '' : 'disabled'}>
            <option value="definitive">Definitivo</option>
            <option value="transient">Transitorio</option>
          </select>
        </label>
        <label>Motivo transitorio<input name="transient_reason" ${can('patients.write') ? '' : 'disabled'}></label>
        <label>Nombre legal<input name="legal_name" ${can('patients.write') ? '' : 'disabled'}></label>
        <label>Nombre social<input name="social_name" ${can('patients.write') ? '' : 'disabled'}></label>
        <label>Fecha nacimiento<input name="birth_date" type="date" ${can('patients.write') ? '' : 'disabled'}></label>
        <label>Establecimiento
          <select name="establishment_id" ${can('patients.write') ? '' : 'disabled'}>
            ${(state.bootstrap.establishments || []).map((item) => `<option value="${item.id}">${item.name}</option>`).join('')}
          </select>
        </label>
        <label>Sector<input name="sector" ${can('patients.write') ? '' : 'disabled'}></label>
        <label>Riesgo<input name="risk" ${can('patients.write') ? '' : 'disabled'}></label>
        <label class="span-2">Notas<textarea name="notes" ${can('patients.write') ? '' : 'disabled'}></textarea></label>
        <div class="form-actions span-2">
          <button type="submit" ${can('patients.write') ? '' : 'disabled'}>Crear paciente</button>
        </div>
      </form>
    `, 'data-modal-kind="patient-create"');
  }
  if (modal.kind === 'appointment-create') {
    return modalShell('Nueva cita', `
      <form id="create-appointment-form" class="form-grid">
        <label>Paciente
          <select name="patient_id" ${can('agenda.write') ? '' : 'disabled'}>
            ${currentPatients().map((item) => `<option value="${item.id}">${item.display_name} · ${item.establishment_name}</option>`).join('')}
          </select>
        </label>
        <label>Canal
          <select name="channel" ${can('agenda.write') ? '' : 'disabled'}>
            ${['meson', 'telefono', 'sms', 'correo'].map((item) => `<option value="${item}">${item}</option>`).join('')}
          </select>
        </label>
        <label>Prestacion visible
          <select name="service_hint" disabled>
            ${(state.bootstrap.services || []).map((item) => `<option value="${item.id}">${item.name}</option>`).join('')}
          </select>
        </label>
        <label>Cupo disponible
          <select name="slot_id" ${can('agenda.write') ? '' : 'disabled'}>
            ${availableSlots().map((slot) => `<option value="${slot.id}">${slot.day} ${slot.time} · ${slot.service_name || slot.service} · ${slot.establishment_name}</option>`).join('')}
          </select>
        </label>
        <label class="span-2">Nota<input name="note" placeholder="Agendado desde ventanilla" ${can('agenda.write') ? '' : 'disabled'}></label>
        <div class="form-actions span-2">
          <button type="submit" ${can('agenda.write') ? '' : 'disabled'}>Crear cita</button>
        </div>
      </form>
    `, 'data-modal-kind="appointment-create"');
  }
  if (modal.kind === 'waitlist-create') {
    const establishments = state.bootstrap.establishments || [];
    const services = (state.bootstrap.services || []).filter((service) => establishments.some((item) => item.id === service.establishment_id));
    return modalShell('Registrar necesidad', `
      <form id="create-waitlist-form" class="form-grid">
        <label>Paciente
          <select name="patient_id" ${can('waitlist.write') ? '' : 'disabled'}>
            ${currentPatients().map((item) => `<option value="${item.id}">${item.display_name} · ${item.establishment_name}</option>`).join('')}
          </select>
        </label>
        <label>Prestacion
          <select name="service_id" ${can('waitlist.write') ? '' : 'disabled'}>
            ${services.map((item) => `<option value="${item.id}">${item.name} · ${item.establishment_name}</option>`).join('')}
          </select>
        </label>
        <label>Establecimiento
          <select name="establishment_id" ${can('waitlist.write') ? '' : 'disabled'}>
            ${establishments.map((item) => `<option value="${item.id}">${item.name}</option>`).join('')}
          </select>
        </label>
        <label class="span-2">Motivo<input name="note" placeholder="Sin cupo disponible en agenda" ${can('waitlist.write') ? '' : 'disabled'}></label>
        <div class="form-actions span-2">
          <button type="submit" ${can('waitlist.write') ? '' : 'disabled'}>Registrar necesidad</button>
        </div>
      </form>
    `, 'data-modal-kind="waitlist-create"');
  }
  if (modal.kind === 'contact-template-create') {
    return modalShell('Crear plantilla', `
      <form id="create-contact-template-form" class="form-grid">
        <label>Codigo<input name="code" placeholder="TPL-CONTACT-01" ${rbac().action_access?.template_manage ? '' : 'disabled'}></label>
        <label>Nombre<input name="name" placeholder="Recordatorio control" ${rbac().action_access?.template_manage ? '' : 'disabled'}></label>
        <label>Version<input name="version" type="number" min="1" value="1" ${rbac().action_access?.template_manage ? '' : 'disabled'}></label>
        <label>Estado
          <select name="status" ${rbac().action_access?.template_manage ? '' : 'disabled'}>
            ${['draft', 'active', 'archived'].map((item) => `<option value="${item}">${item}</option>`).join('')}
          </select>
        </label>
        <label>Canal
          <select name="channel" ${rbac().action_access?.template_manage ? '' : 'disabled'}>
            ${['telefono', 'sms', 'correo', 'whatsapp', 'portal'].map((item) => `<option value="${item}">${item}</option>`).join('')}
          </select>
        </label>
        <label>Idioma
          <select name="language" ${rbac().action_access?.template_manage ? '' : 'disabled'}>
            ${['espanol', 'creole', 'otro'].map((item) => `<option value="${item}">${item}</option>`).join('')}
          </select>
        </label>
        <label class="span-2">Finalidad<input name="purpose" placeholder="contactabilidad_preventiva" ${rbac().action_access?.template_manage ? '' : 'disabled'}></label>
        <label class="span-2">Contenido<textarea name="content" ${rbac().action_access?.template_manage ? '' : 'disabled'} placeholder="Texto aprobado"></textarea></label>
        <label class="span-2 inline-check"><input type="checkbox" name="contains_sensitive_detail" ${rbac().action_access?.template_manage ? '' : 'disabled'}>Permite detalle sensible</label>
        <div class="form-actions span-2">
          <button type="submit" ${rbac().action_access?.template_manage ? '' : 'disabled'}>Crear plantilla</button>
        </div>
      </form>
    `, 'data-modal-kind="contact-template-create"');
  }
  if (modal.kind === 'slot-block') {
    const slot = (state.bootstrap.slots || []).find((item) => item.id === modal.slotId);
    return modalShell('Bloquear cupo', `
      <section class="card detail-card">
        <div class="section-head"><h3>Cupo seleccionado</h3>${badge(slot?.status || 'sin_cupo')}</div>
        <ul class="plain-list">
          <li>ID: <strong>${slot?.id || modal.slotId}</strong>.</li>
          <li>Prestacion: ${slot?.service_name || slot?.service || 'Sin prestacion'}.</li>
          <li>Profesional: ${slot?.professional_name || slot?.professional || 'Sin profesional'}.</li>
          <li>Horario: ${slot?.day || ''} ${slot?.time || ''}.</li>
        </ul>
      </section>
      <form id="block-slot-form" class="form-grid" data-slot-id="${modal.slotId}">
        <label class="span-2">Motivo<input name="reason" value="Bloqueo manual desde UI por ${state.bootstrap?.current_user?.username || 'usuario'}"></label>
        <div class="form-actions span-2">
          <button type="submit">Confirmar bloqueo</button>
        </div>
      </form>
    `, 'data-modal-kind="slot-block"');
  }
  return '';
}

function layout(content) {
  const runtime = state.bootstrap?.runtime;
  const summary = state.bootstrap?.summary;
  const currentUser = state.bootstrap?.current_user;
  const drawerMarkup = renderActiveDrawer();
  const modalMarkup = renderActiveModal();
  app.innerHTML = `
    <div class="shell" data-auth-state="authenticated">
      <aside class="sidebar">
        <div class="brand">
          <span class="mark">QS</span>
          <div>
            <strong>Quilicura Salud</strong>
            <small>Gestion diaria</small>
          </div>
        </div>
        <nav class="nav">${nav.map(([id, label]) => {
          const allowed = canView(id);
          return `<button class="nav-btn ${state.view === id ? 'active' : ''} ${allowed ? '' : 'locked'}" data-view="${id}" ${allowed ? '' : 'disabled'}>${label}${allowed ? '' : '<span class="nav-note">Bloqueado</span>'}</button>`;
        }).join('')}</nav>
        <section class="safe-box">
          <strong>Sesion activa</strong>
          <span>${currentUser?.display_name || 'Usuario'}</span>
          <span>${rbac().role?.label || currentUser?.role || 'Sin rol'}</span>
          <span>Expira: ${sessionExpiresText()}</span>
        </section>
        <section class="safe-box">
          <strong>Alcance visible</strong>
          <span>${scopeList()}</span>
          <span>${(rbac().permissions || []).length} accesos habilitados para esta sesion</span>
          <span>Controles de acceso activos</span>
        </section>
      </aside>
      <main class="main">
        <header class="topbar">
          <div>
            <p class="eyebrow">Quilicura Salud</p>
            <h1>${currentViewLabel()}</h1>
            <p>${currentUser?.facility || 'Quilicura'} · ${rbac().role?.label || currentUser?.role || 'usuario'} · plataforma lista para gestion diaria</p>
          </div>
          <div class="actions">
            <button id="refresh">Actualizar</button>
            <button id="logout" class="ghost">Cerrar sesion</button>
          </div>
        </header>
        <section class="banner">
          ${badge(state.health?.status === 'ok' ? 'Disponible' : state.health?.status || 'offline')}
          <span>${state.health?.status === 'ok' ? 'Sistema disponible para gestion operativa.' : 'Revisa la disponibilidad del sistema antes de continuar.'}</span>
          <span>${summary ? `${summary.active_patients} pacientes en seguimiento · ${summary.managed_patients} con gestion activa · ${summary.audit_entries} movimientos recientes` : 'Sin resumen disponible'}</span>
        </section>
        ${content}
      </main>
    </div>
    ${state.actionMessage ? `<section class="toast ${state.actionMessage.tone}" data-toast><strong>${state.actionMessage.text}</strong><button type="button" class="toast-close" data-close-toast aria-label="Cerrar aviso">×</button></section>` : ''}
    ${drawerMarkup}
    ${modalMarkup}
  `;

  app.querySelectorAll('[data-view]').forEach((button) => {
    if (!button.disabled) {
      button.addEventListener('click', () => {
        state.view = button.dataset.view;
        closeDrawer();
        closeModal();
        render();
      });
    }
  });
  document.getElementById('refresh')?.addEventListener('click', loadProtectedApp);
  document.getElementById('logout')?.addEventListener('click', logout);
  document.querySelector('[data-close-toast]')?.addEventListener('click', () => {
    setActionMessage(null);
    render();
  });
  app.querySelectorAll('[data-sort-view]').forEach((button) => {
    button.addEventListener('click', () => {
      setViewSort(button.dataset.sortView, button.dataset.sortKey);
      render();
    });
  });
  app.querySelectorAll('[data-agenda-panel]').forEach((button) => {
    button.addEventListener('click', () => {
      setAgendaPanel(button.dataset.agendaPanel);
      render();
    });
  });
  app.querySelectorAll('[data-open-drawer]').forEach((button) => {
    button.addEventListener('click', () => {
      openDrawer(button.dataset.openDrawer, button.dataset.id);
      render();
    });
  });
  app.querySelectorAll('[data-open-modal]').forEach((button) => {
    button.addEventListener('click', () => {
      openModal(button.dataset.openModal, { slotId: button.dataset.slotId || '' });
      render();
    });
  });
  app.querySelectorAll('[data-close-overlay]').forEach((button) => {
    button.addEventListener('click', () => {
      closeDrawer();
      closeModal();
      render();
    });
  });
  app.querySelectorAll('[data-drawer-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      setDrawerTab(button.dataset.drawerTab);
      render();
    });
  });
  if (state.view === 'agenda' && canView('agenda')) {
    bindAgendaActions();
  }
  if (state.view === 'patients' && canView('patients')) {
    bindPatientActions();
  }
  if (state.view === 'waitlist' && canView('waitlist')) {
    bindWaitlistActions();
  }
  if (state.view === 'contact' && canView('contact')) {
    bindContactActions();
  }
  if (state.view === 'campaigns' && canView('campaigns')) {
    bindCampaignActions();
  }
  if (state.view === 'sidra' && canView('sidra')) {
    bindSidraActions();
  }
  if (state.view === 'reports' && canView('reports')) {
    bindReportsActions();
  }
}

async function createPatient(data) {
  const payload = await request('/api/v1/pacientes', {
    method: 'POST',
    body: JSON.stringify({
      rut: data.get('rut'),
      identifier_kind: data.get('identifier_kind'),
      transient_reason: data.get('transient_reason'),
      legal_name: data.get('legal_name'),
      social_name: data.get('social_name'),
      birth_date: data.get('birth_date'),
      establishment_id: data.get('establishment_id'),
      sector: data.get('sector'),
      risk: data.get('risk'),
      notes: data.get('notes')
    })
  });
  applyBootstrap(payload);
  state.selectedPatientId = payload.patient?.id || state.selectedPatientId;
  closeModal();
  openDrawer('patient', state.selectedPatientId);
  setActionMessage(payload.message, 'pass');
  render();
}

async function updatePatient(patientId, data) {
  const payload = await request(`/api/v1/pacientes/${encodeURIComponent(patientId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      rut: data.get('rut'),
      identifier_kind: data.get('identifier_kind'),
      legal_name: data.get('legal_name'),
      social_name: data.get('social_name'),
      birth_date: data.get('birth_date'),
      status: data.get('status'),
      establishment_id: data.get('establishment_id'),
      sector: data.get('sector'),
      risk: data.get('risk'),
      notes: data.get('notes'),
      closure_reason: data.get('closure_reason')
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

async function addContact(patientId, data) {
  const payload = await request(`/api/v1/pacientes/${encodeURIComponent(patientId)}/contactos`, {
    method: 'POST',
    body: JSON.stringify({
      type: data.get('type'),
      channel: data.get('channel'),
      label: data.get('label'),
      value: data.get('value'),
      source: data.get('source'),
      verified: data.get('verified') === 'on'
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

async function toggleContactExclusion(patientId, contact) {
  const payload = await request(`/api/v1/pacientes/${encodeURIComponent(patientId)}/contactos/${encodeURIComponent(contact.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      excluded_from_non_urgent: !contact.excluded_from_non_urgent
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

async function addRepresentative(patientId, data) {
  const payload = await request(`/api/v1/pacientes/${encodeURIComponent(patientId)}/representantes`, {
    method: 'POST',
    body: JSON.stringify({
      legal_name: data.get('legal_name'),
      relation: data.get('relation'),
      phone: data.get('phone'),
      verified: data.get('verified') === 'on',
      notes: data.get('notes')
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

async function verifyRepresentative(patientId, representative) {
  const payload = await request(`/api/v1/pacientes/${encodeURIComponent(patientId)}/representantes/${encodeURIComponent(representative.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      legal_name: representative.legal_name,
      relation: representative.relation,
      phone: representative.phone,
      status: representative.status,
      notes: representative.notes,
      verified: true
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

async function updatePreferences(patientId, data) {
  const payload = await request(`/api/v1/pacientes/${encodeURIComponent(patientId)}/preferencias`, {
    method: 'PATCH',
    body: JSON.stringify({
      preferred_channel: data.get('preferred_channel'),
      language: data.get('language'),
      allow_non_urgent: data.get('allow_non_urgent') === 'on',
      notes: data.get('notes')
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

function parseChannelScope(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function addConsent(patientId, data) {
  const payload = await request(`/api/v1/pacientes/${encodeURIComponent(patientId)}/consentimientos`, {
    method: 'POST',
    body: JSON.stringify({
      purpose: data.get('purpose'),
      channel_scope: parseChannelScope(data.get('channel_scope')),
      source: data.get('source'),
      granted: data.get('granted') === 'on',
      status: data.get('granted') === 'on' ? 'vigente' : 'revocado',
      notes: data.get('notes')
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

async function revokeConsent(patientId, consent) {
  const payload = await request(`/api/v1/pacientes/${encodeURIComponent(patientId)}/consentimientos/${encodeURIComponent(consent.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      purpose: consent.purpose,
      channel_scope: consent.channel_scope,
      source: consent.source,
      notes: consent.notes,
      granted: false,
      status: 'revocado'
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

function filteredWaitlist() {
  const rows = currentWaitlist();
  const query = state.query.trim().toLowerCase();
  const filtered = !query ? rows : rows.filter((item) => [
    item.id,
    item.patient_name,
    item.service,
    item.establishment_name,
    item.priority,
    item.status
  ].some((value) => String(value || '').toLowerCase().includes(query)));
  return sortRows(filtered, state.sortBy.waitlist, {
    default: (left, right) => compareNumber(left.priority_rank, right.priority_rank) || compareText(left.id, right.id),
    priority: (left, right) => compareNumber(left.priority_rank, right.priority_rank) || compareText(left.id, right.id),
    patient: (left, right) => compareText(left.patient_name, right.patient_name),
    service: (left, right) => compareText(left.service, right.service),
    status: (left, right) => compareText(left.status, right.status) || compareNumber(left.priority_rank, right.priority_rank)
  });
}

function waitlistOfferableSlots(entry) {
  return availableSlots().filter((slot) => slot.service_id === entry?.service_id);
}

async function createWaitlistEntry(data) {
  const payload = await request('/api/v1/lista-espera', {
    method: 'POST',
    body: JSON.stringify({
      patient_id: data.get('patient_id'),
      service_id: data.get('service_id'),
      establishment_id: data.get('establishment_id'),
      source: 'ui_waitlist_r05',
      note: data.get('note')
    })
  });
  applyBootstrap(payload);
  state.selectedWaitlistId = payload.waitlist_entry?.id || state.selectedWaitlistId;
  closeModal();
  openDrawer('waitlist', state.selectedWaitlistId);
  setActionMessage(payload.message, 'pass');
  render();
}

async function offerWaitlistEntry(waitlistId, data) {
  const payload = await request(`/api/v1/lista-espera/${encodeURIComponent(waitlistId)}/ofertas`, {
    method: 'POST',
    body: JSON.stringify({
      slot_id: data.get('slot_id'),
      note: data.get('note')
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

async function resolveWaitlistOffer(offerId, data) {
  const payload = await request(`/api/v1/lista-espera/ofertas/${encodeURIComponent(offerId)}/resolver`, {
    method: 'POST',
    body: JSON.stringify({
      resolution: data.get('resolution'),
      reason: data.get('reason')
    })
  });
  applyBootstrap(payload);
  if (payload.appointment?.id) {
    state.selectedAppointmentId = payload.appointment.id;
  }
  setActionMessage(payload.message, 'pass');
  render();
}

async function closeWaitlistEntry(waitlistId, data) {
  const payload = await request(`/api/v1/lista-espera/${encodeURIComponent(waitlistId)}/cerrar`, {
    method: 'POST',
    body: JSON.stringify({
      reason: data.get('reason')
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

function filteredContactCases() {
  const rows = currentContactCases();
  const query = state.query.trim().toLowerCase();
  const filtered = !query ? rows : rows.filter((item) => [
    item.id,
    item.patient_name,
    item.purpose,
    item.status,
    item.establishment_name
  ].some((value) => String(value || '').toLowerCase().includes(query)));
  return sortRows(filtered, state.sortBy.contact, {
    default: (left, right) => compareDate(right.updated_at || right.created_at, left.updated_at || left.created_at) || compareText(left.id, right.id),
    recent: (left, right) => compareDate(right.updated_at || right.created_at, left.updated_at || left.created_at) || compareText(left.id, right.id),
    patient: (left, right) => compareText(left.patient_name, right.patient_name),
    attempts: (left, right) => compareNumber(right.attempt_count, left.attempt_count) || compareText(left.patient_name, right.patient_name),
    status: (left, right) => compareText(left.status, right.status) || compareDate(right.updated_at || right.created_at, left.updated_at || left.created_at)
  });
}

async function createContactTemplate(data) {
  const payload = await request('/api/v1/contactabilidad/plantillas', {
    method: 'POST',
    body: JSON.stringify({
      code: data.get('code'),
      name: data.get('name'),
      channel: data.get('channel'),
      purpose: data.get('purpose'),
      language: data.get('language'),
      status: data.get('status'),
      version: Number(data.get('version') || 1),
      contains_sensitive_detail: data.get('contains_sensitive_detail') === 'on',
      content: data.get('content')
    })
  });
  applyBootstrap(payload);
  closeModal();
  setActionMessage(payload.message, 'pass');
  render();
}

async function sendContactMessage(data) {
  const payload = await request('/api/v1/contactabilidad/envios', {
    method: 'POST',
    body: JSON.stringify({
      patient_id: data.get('patient_id'),
      template_id: data.get('template_id'),
      purpose: data.get('purpose'),
      channel: data.get('channel'),
      detail: data.get('detail'),
      contains_sensitive_detail: data.get('contains_sensitive_detail') === 'on'
    })
  });
  applyBootstrap(payload);
  state.selectedContactCaseId = payload.contact_case?.id || state.selectedContactCaseId;
  openDrawer('contact-case', state.selectedContactCaseId);
  setActionMessage(payload.message, 'pass');
  render();
}

async function resolveContactMessage(data) {
  const payload = await request('/api/v1/contactabilidad/webhook', {
    method: 'POST',
    body: JSON.stringify({
      message_id: data.get('message_id'),
      status: data.get('status'),
      result: data.get('result'),
      detail: data.get('detail')
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

async function closeContactCase(caseId, data) {
  const payload = await request(`/api/v1/contactabilidad/casos/${encodeURIComponent(caseId)}/cerrar`, {
    method: 'POST',
    body: JSON.stringify({
      closure_kind: data.get('closure_kind'),
      reason: data.get('reason')
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

function filteredCampaigns() {
  const rows = state.bootstrap?.campaigns || [];
  const query = state.query.trim().toLowerCase();
  if (!query) {
    return rows;
  }
  return rows.filter((item) => [
    item.id,
    item.name,
    item.purpose,
    item.channel,
    item.establishment_name,
    item.status
  ].some((value) => String(value || '').toLowerCase().includes(query)));
}

async function createCampaign(data) {
  const payload = await request('/api/v1/campanas', {
    method: 'POST',
    body: JSON.stringify({
      name: data.get('name'),
      purpose: data.get('purpose'),
      channel: data.get('channel'),
      audience: data.get('audience'),
      establishment_id: data.get('establishment_id'),
      template_id: data.get('template_id'),
      survey_id: data.get('survey_id') || null,
      segmentation_mode: 'manual'
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

async function approveCampaign(data) {
  const payload = await request(`/api/v1/campanas/${encodeURIComponent(data.get('campaign_id'))}/aprobacion`, {
    method: 'POST',
    body: JSON.stringify({
      approval_note: data.get('approval_note')
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

async function scheduleCampaign(data) {
  const payload = await request(`/api/v1/campanas/${encodeURIComponent(data.get('campaign_id'))}/programacion`, {
    method: 'POST',
    body: JSON.stringify({
      scheduled_at: data.get('scheduled_at'),
      execution_note: data.get('execution_note')
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

async function exportCampaignMetrics(data) {
  const payload = await request(`/api/v1/campanas/${encodeURIComponent(data.get('campaign_id'))}/exportacion`, {
    method: 'POST',
    body: JSON.stringify({
      purpose: data.get('purpose'),
      identifiable: false
    })
  });
  setActionMessage(`Exportacion agregada lista: ${payload.export.metrics.delivered} envios / ${payload.export.metrics.responded} respuestas.`, 'pass');
  render();
}

async function recordSurveyResponse(data) {
  const payload = await request(`/api/v1/encuestas/${encodeURIComponent(data.get('survey_id'))}/respuestas`, {
    method: 'POST',
    body: JSON.stringify({
      campaign_id: data.get('campaign_id'),
      patient_id: data.get('patient_id'),
      score: Number(data.get('score')),
      comment: data.get('comment'),
      channel: data.get('channel')
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

function filteredReports() {
  const rows = currentReports();
  const query = state.query.trim().toLowerCase();
  if (!query) {
    return rows;
  }
  return rows.filter((item) => [
    item.id,
    item.period,
    item.generated_by,
    item.filters?.establishment_id,
    item.filters?.service_id,
    item.filters?.channel
  ].some((value) => String(value || '').toLowerCase().includes(query)));
}

async function createMonthlyReport(data) {
  const payload = await request('/api/v1/reportes/mensual', {
    method: 'POST',
    body: JSON.stringify({
      period: data.get('period'),
      establishment_id: data.get('establishment_id') || null,
      service_id: data.get('service_id') || null,
      channel: data.get('channel') || null
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

async function exportMonthlyReport(data) {
  const payload = await request('/api/v1/reportes/mensual/exportacion', {
    method: 'POST',
    body: JSON.stringify({
      period: data.get('period'),
      establishment_id: data.get('establishment_id') || null,
      service_id: data.get('service_id') || null,
      channel: data.get('channel') || null,
      purpose: data.get('purpose'),
      identifiable: false
    })
  });
  const totals = payload.export?.report?.totals || {};
  setActionMessage(`Exportacion agregada lista: ${totals.appointments_created || 0} citas y ${totals.contact_attempts || 0} contactos.`, 'pass');
  render();
}

async function createBackup(data) {
  const payload = await request('/api/v1/continuidad/backups', {
    method: 'POST',
    body: JSON.stringify({
      label: data.get('label'),
      note: data.get('note')
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

async function restoreBackup(data) {
  const payload = await request('/api/v1/continuidad/restores', {
    method: 'POST',
    body: JSON.stringify({
      backup_id: data.get('backup_id')
    })
  });
  clearAuth('Respaldo restaurado. Inicia sesion nuevamente para recargar el estado restaurado.');
  setActionMessage(payload.message, 'pass');
  render();
}

function filteredSidraEvents() {
  const rows = currentSidraEvents();
  const query = state.query.trim().toLowerCase();
  const filtered = !query ? rows : rows.filter((item) => [
    item.id,
    item.type,
    item.entity,
    item.entity_id,
    item.status,
    item.establishment_name
  ].some((value) => String(value || '').toLowerCase().includes(query)));
  return sortRows(filtered, state.sortBy.sidra, {
    default: (left, right) => compareText(left.status, right.status) || compareDate(right.created_at, left.created_at),
    status: (left, right) => compareText(left.status, right.status) || compareDate(right.created_at, left.created_at),
    recent: (left, right) => compareDate(right.created_at, left.created_at),
    retries: (left, right) => compareNumber(right.retries, left.retries) || compareText(left.id, right.id),
    event: (left, right) => compareText(left.type, right.type)
  });
}

async function createSidraEvent(data) {
  const payload = await request('/api/v1/sidra/eventos', {
    method: 'POST',
    body: JSON.stringify({
      type: data.get('type'),
      entity: data.get('entity'),
      entity_id: data.get('entity_id'),
      establishment_id: data.get('establishment_id'),
      simulation_default_result: data.get('simulation_default_result'),
      payload: {
        source: 'ui_sidra_r07',
        note: data.get('note')
      }
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

async function processSidraEvent(eventId, data) {
  const payload = await request(`/api/v1/sidra/eventos/${encodeURIComponent(eventId)}/procesar`, {
    method: 'POST',
    body: JSON.stringify({
      result: data.get('result'),
      detail: data.get('detail'),
      error_code: data.get('error_code')
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

async function retrySidraEvent(eventId, data) {
  const payload = await request(`/api/v1/sidra/eventos/${encodeURIComponent(eventId)}/reintentar`, {
    method: 'POST',
    body: JSON.stringify({
      detail: data.get('detail')
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

async function resolveSidraDiscrepancy(eventId, data) {
  const payload = await request(`/api/v1/sidra/eventos/${encodeURIComponent(eventId)}/discrepancia/resolver`, {
    method: 'POST',
    body: JSON.stringify({
      resolution_note: data.get('resolution_note')
    })
  });
  applyBootstrap(payload);
  setActionMessage(payload.message, 'pass');
  render();
}

function bindAgendaActions() {
  app.querySelectorAll('[data-select-appointment]').forEach((button) => {
    button.addEventListener('click', () => {
      openDrawer('appointment', button.dataset.selectAppointment);
      render();
    });
  });
  document.getElementById('create-appointment-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await createAppointment(new FormData(event.currentTarget));
      event.currentTarget.reset();
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('confirm-appointment-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await confirmAppointment(state.selectedAppointmentId, new FormData(event.currentTarget));
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('cancel-appointment-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await cancelAppointment(state.selectedAppointmentId, new FormData(event.currentTarget));
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('reschedule-appointment-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await rescheduleAppointment(state.selectedAppointmentId, new FormData(event.currentTarget));
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('block-slot-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await blockSlot(event.currentTarget.dataset.slotId, new FormData(event.currentTarget).get('reason'));
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
}

function bindPatientActions() {
  app.querySelectorAll('[data-select-patient]').forEach((button) => {
    button.addEventListener('click', () => {
      openDrawer('patient', button.dataset.selectPatient);
      render();
    });
  });
  document.getElementById('create-patient-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await createPatient(new FormData(event.currentTarget));
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('edit-patient-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await updatePatient(state.selectedPatientId, new FormData(event.currentTarget));
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('add-contact-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await addContact(state.selectedPatientId, new FormData(event.currentTarget));
      event.currentTarget.reset();
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('add-representative-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await addRepresentative(state.selectedPatientId, new FormData(event.currentTarget));
      event.currentTarget.reset();
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('update-preferences-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await updatePreferences(state.selectedPatientId, new FormData(event.currentTarget));
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('add-consent-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await addConsent(state.selectedPatientId, new FormData(event.currentTarget));
      event.currentTarget.reset();
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });

  const patient = selectedPatient();
  app.querySelectorAll('[data-toggle-contact]').forEach((button) => {
    button.addEventListener('click', async () => {
      const contact = patient?.contacts.find((item) => item.id === button.dataset.toggleContact);
      if (!contact) {
        return;
      }
      try {
        await toggleContactExclusion(state.selectedPatientId, contact);
      } catch (error) {
        setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
        render();
      }
    });
  });
  app.querySelectorAll('[data-verify-representative]').forEach((button) => {
    button.addEventListener('click', async () => {
      const representative = patient?.representatives.find((item) => item.id === button.dataset.verifyRepresentative);
      if (!representative) {
        return;
      }
      try {
        await verifyRepresentative(state.selectedPatientId, representative);
      } catch (error) {
        setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
        render();
      }
    });
  });
  app.querySelectorAll('[data-revoke-consent]').forEach((button) => {
    button.addEventListener('click', async () => {
      const consent = patient?.consents.find((item) => item.id === button.dataset.revokeConsent);
      if (!consent) {
        return;
      }
      try {
        await revokeConsent(state.selectedPatientId, consent);
      } catch (error) {
        setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
        render();
      }
    });
  });
}

function bindWaitlistActions() {
  app.querySelectorAll('[data-select-waitlist]').forEach((button) => {
    button.addEventListener('click', () => {
      openDrawer('waitlist', button.dataset.selectWaitlist);
      render();
    });
  });
  document.getElementById('create-waitlist-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await createWaitlistEntry(new FormData(event.currentTarget));
      event.currentTarget.reset();
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('offer-waitlist-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await offerWaitlistEntry(state.selectedWaitlistId, new FormData(event.currentTarget));
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('resolve-waitlist-offer-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const offerId = event.currentTarget.dataset.offerId;
    if (!offerId) {
      setActionMessage('No hay oferta activa para resolver.', 'warn');
      render();
      return;
    }
    try {
      await resolveWaitlistOffer(offerId, new FormData(event.currentTarget));
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('close-waitlist-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await closeWaitlistEntry(state.selectedWaitlistId, new FormData(event.currentTarget));
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
}

function bindContactActions() {
  app.querySelectorAll('[data-select-contact-case]').forEach((button) => {
    button.addEventListener('click', () => {
      openDrawer('contact-case', button.dataset.selectContactCase);
      render();
    });
  });
  document.getElementById('create-contact-template-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await createContactTemplate(new FormData(event.currentTarget));
      event.currentTarget.reset();
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('send-contact-message-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await sendContactMessage(new FormData(event.currentTarget));
      event.currentTarget.reset();
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' || error.payload?.error === 'not_contactable' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('resolve-contact-message-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await resolveContactMessage(new FormData(event.currentTarget));
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('close-contact-case-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await closeContactCase(state.selectedContactCaseId, new FormData(event.currentTarget));
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
}

function bindCampaignActions() {
  document.getElementById('create-campaign-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await createCampaign(new FormData(event.currentTarget));
      event.currentTarget.reset();
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('approve-campaign-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await approveCampaign(new FormData(event.currentTarget));
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('schedule-campaign-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await scheduleCampaign(new FormData(event.currentTarget));
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('export-campaign-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await exportCampaignMetrics(new FormData(event.currentTarget));
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('survey-response-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await recordSurveyResponse(new FormData(event.currentTarget));
      event.currentTarget.reset();
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
}

function bindReportsActions() {
  document.getElementById('create-report-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await createMonthlyReport(new FormData(event.currentTarget));
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('export-report-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await exportMonthlyReport(new FormData(event.currentTarget));
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('create-backup-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await createBackup(new FormData(event.currentTarget));
      event.currentTarget.reset();
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('restore-backup-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await restoreBackup(new FormData(event.currentTarget));
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
}

function bindSidraActions() {
  document.getElementById('create-sidra-event-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await createSidraEvent(new FormData(event.currentTarget));
      event.currentTarget.reset();
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('sidra-process-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await processSidraEvent(state.activeDrawer?.id, new FormData(event.currentTarget));
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('sidra-retry-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await retrySidraEvent(state.activeDrawer?.id, new FormData(event.currentTarget));
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
  document.getElementById('sidra-resolve-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await resolveSidraDiscrepancy(state.activeDrawer?.id, new FormData(event.currentTarget));
    } catch (error) {
      setActionMessage(error.message, error.payload?.error === 'permission_denied' ? 'denied' : 'warn');
      render();
    }
  });
}

const views = {
  dashboard() {
    const summary = state.bootstrap.summary;
    const role = rbac().role?.label || 'Sin rol';
    return `
      ${cards([
        ['Pacientes activos', summary.active_patients, 'Seguimiento diario'],
        ['Citas activas', summary.active_appointments, 'Agenda de hoy y proximas atenciones'],
        ['Cupos disponibles', summary.available_slots, 'Disponibilidad visible para el equipo'],
        ['Accesos del perfil', (rbac().permissions || []).length, role]
      ])}
      <div class="grid two">
        <section class="card">
          <div class="section-head"><h2>Accesos del perfil</h2>${badge(role)}</div>
          <div class="permission-grid">${(rbac().permissions_catalog || []).map((permission) => `<article class="permission-item ${can(permission.id) ? 'enabled' : 'disabled'}"><strong>${permission.label}</strong><small>${can(permission.id) ? 'Disponible en esta sesion' : 'No disponible para este perfil'}</small></article>`).join('')}</div>
        </section>
        <section class="card">
          <div class="section-head"><h2>Cobertura actual</h2>${badge('Quilicura')}</div>
          <ul class="plain-list">
            <li>Establecimientos visibles: ${scopeList()}.</li>
            <li>La agenda, la lista de espera y la contactabilidad mantienen continuidad operativa para la gestion interna.</li>
            <li>Los flujos sensibles permanecen contenidos y sin integraciones externas activas.</li>
          </ul>
        </section>
      </div>
    `;
  },
  agenda() {
    const filtered = filteredAgendaSlots();
    const appointments = filteredAppointments();
    const agendaPanelButtons = `
      <div class="subnav-tabs" role="tablist" aria-label="Submenu agenda">
        <button class="subnav-tab ${state.agendaPanel === 'appointments' ? 'active' : ''}" type="button" data-agenda-panel="appointments">Citas visibles</button>
        <button class="subnav-tab ${state.agendaPanel === 'availability' ? 'active' : ''}" type="button" data-agenda-panel="availability">Disponibilidad real</button>
      </div>
    `;
    return `
      ${compactSummaryCards([
        ['Citas visibles', appointments.length, 'Agenda operativa'],
        ['Cupos disponibles', filtered.filter((item) => item.status === 'disponible').length, 'Sin doble reserva'],
        ['Bloqueos posibles', filtered.filter((item) => item.allowed_actions?.block).length, 'Accion sensible confirmada']
      ])}
      <section class="card">
        <div class="section-head"><h2>Agenda operativa</h2>${badge(can('agenda.write') ? 'agenda.write' : 'agenda.read')}</div>
        <p class="muted">${can('agenda.write') ? 'La agenda mantiene reservas reales y concentra mutaciones en paneles laterales para evitar scroll operativo innecesario.' : 'Tu rol puede revisar agenda, pero no crear citas.'}</p>
        <div class="hero-actions">
          <button class="slot-action" type="button" data-open-modal="appointment-create" ${can('agenda.write') ? '' : 'disabled'}>Nueva cita</button>
          <span class="inline-note">Usa el buscador superior para filtrar por cupo, profesional, paciente o establecimiento.</span>
        </div>
        ${agendaPanelButtons}
      </section>
      ${state.agendaPanel === 'availability' ? `
        <section class="card">
          <div class="section-head"><h2>Disponibilidad real</h2>${badge(filtered.length)}</div>
          <div class="stack scroll-region scroll-region-xl">${filtered.map((slot) => `
            <article class="slot">
              <div>
                <strong>${slot.day} ${slot.time} · ${slot.service_name || slot.service}</strong>
                <span>${slot.professional_name || slot.professional}</span>
                <small class="slot-meta">${slot.id} · ${slot.establishment_name}</small>
              </div>
              <div class="slot-actions">
                ${badge(slot.status)}
                ${slot.allowed_actions?.block ? `<button class="slot-action" type="button" data-open-modal="slot-block" data-slot-id="${slot.id}">Bloquear cupo</button>` : `<span class="inline-note">${slot.allowed_actions?.book ? 'Reservable desde modal' : 'No reservable'}</span>`}
              </div>
            </article>
          `).join('')}</div>
        </section>
      ` : `
        <section class="card">
        <div class="section-head"><h2>Citas visibles</h2>${badge(appointments.length)}</div>
        <p class="muted">Ordena directamente por columnas en la tabla.</p>
        <div class="table-wrap scroll-region scroll-region-xl"><table><thead><tr><th>${sortHeader('agenda', 'id', 'ID')}</th><th>${sortHeader('agenda', 'patient', 'Paciente')}</th><th>Prestacion</th><th>${sortHeader('agenda', 'time', 'Cupo')}</th><th>${sortHeader('agenda', 'status', 'Estado')}</th><th>Accion</th></tr></thead><tbody>${appointments.map((item) => `<tr class="${item.id === state.selectedAppointmentId ? 'row-active' : ''}"><td>${item.id}</td><td>${item.patient_name}</td><td>${item.service_name || '-'}</td><td>${item.slot_label}</td><td>${badge(item.status)}</td><td><button class="slot-action secondary" type="button" data-open-drawer="appointment" data-id="${item.id}">Gestionar</button></td></tr>`).join('')}</tbody></table></div>
        </section>
      `}
    `;
  },
  patients() {
    const patients = filteredPatients();
    const manage = can('patients.write');
    return `
      ${compactSummaryCards([
        ['Pacientes visibles', patients.length, 'Listado principal'],
        ['Gestionables', patients.filter((item) => item.allowed_actions?.manage).length, 'Segun RBAC'],
        ['Con contacto', patients.filter((item) => (item.contacts || []).length).length, 'Seguimiento disponible']
      ])}
      <section class="card">
          <div class="section-head"><h2>Pacientes visibles</h2>${badge(patients.length)}</div>
          <p class="muted">${manage ? 'La alta de pacientes queda arriba y la ficha abre en drawer con tabs fijos para evitar que se escondan.' : 'Tu rol puede consultar la ficha, pero no mutarla.'}</p>
          <div class="hero-actions">
            <button class="slot-action" type="button" data-open-modal="patient-create" ${manage ? '' : 'disabled'}>Nuevo paciente</button>
            <span class="inline-note">Ordena directamente por columnas en el listado.</span>
          </div>
          <div class="table-wrap scroll-region scroll-region-xl"><table><thead><tr><th>${sortHeader('patients', 'name', 'Paciente')}</th><th>${sortHeader('patients', 'age', 'Edad')}</th><th>Estado</th><th>Establecimiento</th><th>${sortHeader('patients', 'id', 'Accion / ID')}</th></tr></thead><tbody>${patients.map((item) => `<tr class="${item.id === state.selectedPatientId ? 'row-active' : ''}"><td><strong>${item.display_name}</strong><small>${item.id} · ${item.rut || item.identifier_kind}</small></td><td>${patientAgeLabel(item)}</td><td>${badge(item.status)}</td><td>${item.establishment_name}</td><td><button class="slot-action secondary" type="button" data-open-drawer="patient" data-id="${item.id}">Abrir ficha</button></td></tr>`).join('')}</tbody></table></div>
      </section>
    `;
  },
  waitlist() {
    const entries = filteredWaitlist();
    const writable = can('waitlist.write');
    return `
      ${compactSummaryCards([
        ['Necesidades activas', entries.length, 'Lista priorizada'],
        ['Con oferta activa', entries.filter((item) => item.active_offer).length, 'Seguimiento pendiente'],
        ['Alta prioridad', entries.filter((item) => item.priority === 'alta').length, 'Visibilidad operativa']
      ])}
      <section class="card">
          <div class="section-head"><h2>Esperas visibles</h2>${badge(entries.length)}</div>
          <p class="muted">La bandeja principal queda arriba; el registro de necesidad se mueve abajo para priorizar lectura y resolucion.</p>
          <div class="table-wrap scroll-region scroll-region-xl"><table><thead><tr><th>ID</th><th>${sortHeader('waitlist', 'patient', 'Paciente')}</th><th>${sortHeader('waitlist', 'service', 'Prestacion')}</th><th>${sortHeader('waitlist', 'priority', 'Prioridad')}</th><th>${sortHeader('waitlist', 'status', 'Estado')}</th><th>Accion</th></tr></thead><tbody>${entries.map((item) => `<tr class="${item.id === state.selectedWaitlistId ? 'row-active' : ''}"><td>${item.id}</td><td>${item.patient_name}</td><td>${item.service}</td><td>${badge(item.priority)}</td><td>${badge(item.status)}</td><td><button class="slot-action secondary" type="button" data-open-drawer="waitlist" data-id="${item.id}">Gestionar</button></td></tr>`).join('')}</tbody></table></div>
      </section>
      <section class="card">
        <div class="section-head"><h2>Operacion de espera</h2>${badge(writable ? 'waitlist.write' : 'waitlist.read')}</div>
        <p class="muted">${writable ? 'Las necesidades nuevas pasan a modal; la resolucion y la oferta quedan en drawer.' : 'Tu rol puede revisar espera, pero no crear ni resolver ofertas.'}</p>
        <div class="hero-actions">
          <button class="slot-action" type="button" data-open-modal="waitlist-create" ${writable ? '' : 'disabled'}>Registrar necesidad</button>
          <span class="inline-note">Puedes ordenar por columnas en el listado principal.</span>
        </div>
      </section>
    `;
  },
  contact() {
    const patients = currentPatients();
    const templates = currentContactTemplates();
    const cases = filteredContactCases();
    return `
      ${compactSummaryCards([
        ['Casos abiertos', cases.length, 'Bandeja priorizada'],
        ['Plantillas activas', templates.filter((item) => item.status === 'active').length, 'Versionadas'],
        ['Mensajes emitidos', currentContactMessages().length, 'Historial disponible']
      ])}
      <div class="grid two surface-grid">
        <section class="card">
          <div class="section-head"><h2>Enviar contacto</h2>${badge(can('contact.write') ? 'contact.write' : 'contact.read')}</div>
          <p class="muted">${can('contact.write') ? 'La bandeja exige finalidad sanitaria, consentimiento, plantilla activa y canal permitido.' : 'Tu rol puede revisar casos, pero no enviar mensajes.'}</p>
          <form id="send-contact-message-form" class="form-grid">
            <label>Paciente
              <select name="patient_id" ${can('contact.write') ? '' : 'disabled'}>
                ${patients.map((item) => `<option value="${item.id}">${item.display_name} · ${item.establishment_name}</option>`).join('')}
              </select>
            </label>
            <label>Plantilla
              <select name="template_id" ${can('contact.write') ? '' : 'disabled'}>
                ${templates.filter((item) => item.status === 'active').map((item) => `<option value="${item.id}">${item.code} v${item.version} · ${item.channel}</option>`).join('')}
              </select>
            </label>
            <label>Finalidad<input name="purpose" placeholder="recordatorio_cita" ${can('contact.write') ? '' : 'disabled'}></label>
            <label>Canal
              <select name="channel" ${can('contact.write') ? '' : 'disabled'}>
                ${['telefono', 'sms', 'correo', 'whatsapp', 'portal'].map((item) => `<option value="${item}">${item}</option>`).join('')}
              </select>
            </label>
            <label class="span-2">Detalle<textarea name="detail" ${can('contact.write') ? '' : 'disabled'} placeholder="Mensaje aprobado para envio"></textarea></label>
            <label class="span-2 inline-check"><input type="checkbox" name="contains_sensitive_detail" ${can('contact.write') ? '' : 'disabled'}>Contiene detalle sensible</label>
            <div class="form-actions span-2">
              <button type="submit" ${can('contact.write') ? '' : 'disabled'}>Registrar envio</button>
              <span class="inline-note">SMS, correo y WhatsApp bloquean detalle sensible por codigo.</span>
            </div>
          </form>
        </section>
        <section class="card">
          <div class="section-head"><h2>Plantillas versionadas</h2>${badge(templates.length)}</div>
          <div class="stack compact">${templates.map((item) => `
            <article class="stack-card">
              <div>
                <strong>${item.code} v${item.version}</strong>
                <span>${item.name} · ${item.channel} · ${item.purpose}</span>
                <small>${item.language} · ${item.contains_sensitive_detail ? 'detalle sensible' : 'sin detalle sensible'}</small>
              </div>
              <div class="slot-actions">${badge(item.status)}</div>
            </article>
          `).join('')}</div>
          <div class="hero-actions">
            <button class="slot-action secondary" type="button" data-open-modal="contact-template-create" ${rbac().action_access?.template_manage ? '' : 'disabled'}>Crear plantilla</button>
          </div>
        </section>
      </div>
      <div class="grid two surface-grid">
        <section class="card span-full">
          <div class="section-head"><h2>Casos de contactabilidad</h2>${badge(cases.length)}</div>
          <p class="muted">La vista se puede buscar y ordenar por columnas.</p>
          <div class="table-wrap scroll-region scroll-region-xl"><table><thead><tr><th>${sortHeader('contact', 'patient', 'Paciente')}</th><th>Finalidad</th><th>${sortHeader('contact', 'attempts', 'Intentos')}</th><th>${sortHeader('contact', 'status', 'Estado')}</th><th>${sortHeader('contact', 'recent', 'Actualizado')}</th><th>Accion</th></tr></thead><tbody>${cases.map((item) => `<tr class="${item.id === state.selectedContactCaseId ? 'row-active' : ''}"><td><strong>${item.patient_name}</strong><small>${item.id} · ${item.establishment_name}</small></td><td>${item.purpose}</td><td>${item.attempt_count} / ${item.channel_count} canales</td><td>${badge(item.status)}</td><td>${item.updated_at || item.created_at || '-'}</td><td><button class="slot-action secondary" type="button" data-open-drawer="contact-case" data-id="${item.id}">Abrir</button></td></tr>`).join('')}</tbody></table></div>
        </section>
      </div>
    `;
  },
  campaigns() {
    const campaigns = filteredCampaigns();
    const canManage = rbac().action_access?.campaign_manage;
    const canExport = rbac().action_access?.campaign_export;
    const establishments = state.bootstrap.establishments || [];
    const templates = state.bootstrap.contact_templates || [];
    const surveys = state.bootstrap.surveys || [];
    const patients = currentPatients();
    return `
      <section class="card notice">
        <h2>Campanas y encuestas</h2>
        <p>${canManage ? 'Puedes crear, aprobar, programar y revisar metricas agregadas con finalidad sanitaria.' : 'Tu rol puede revisar campanas visibles, pero no mutarlas.'}</p>
      </section>
      <section class="card">
        <div class="section-head"><h2>Campanas visibles</h2>${badge('campaigns.read')}</div>
        <table><thead><tr><th>ID</th><th>Nombre</th><th>Finalidad</th><th>Establecimiento</th><th>Canal</th><th>Estado</th><th>Envios</th><th>Respuestas</th></tr></thead><tbody>${campaigns.map((item) => `<tr><td>${item.id}</td><td>${item.name}</td><td>${item.purpose}</td><td>${item.establishment_name}</td><td>${item.channel}</td><td>${badge(item.status)}</td><td>${item.metrics?.delivered || item.sent || 0}</td><td>${item.metrics?.responded || 0}</td></tr>`).join('')}</tbody></table>
      </section>
      <section class="card">
        <div class="section-head"><h2>Encuestas activas</h2>${badge(surveys.length)}</div>
        <table><thead><tr><th>ID</th><th>Nombre</th><th>Version</th><th>Finalidad</th><th>Estado</th><th>Promedio</th></tr></thead><tbody>${surveys.map((item) => `<tr><td>${item.id}</td><td>${item.name}</td><td>${item.version}</td><td>${item.purpose}</td><td>${badge(item.status)}</td><td>${item.average_score ?? '-'}</td></tr>`).join('')}</tbody></table>
      </section>
      <div class="grid two">
        <section class="card">
          <div class="section-head"><h2>Crear campana</h2>${badge(canManage ? 'campaigns.manage' : 'solo_lectura')}</div>
          <form id="create-campaign-form" class="form-grid">
            <label>Nombre<input name="name" placeholder="Campana control invierno" ${canManage ? '' : 'disabled'}></label>
            <label>Finalidad<input name="purpose" placeholder="promocion_preventiva" ${canManage ? '' : 'disabled'}></label>
            <label>Canal
              <select name="channel" ${canManage ? '' : 'disabled'}>
                ${['sms', 'correo', 'whatsapp', 'telefono'].map((item) => `<option value="${item}">${item}</option>`).join('')}
              </select>
            </label>
            <label>Establecimiento
              <select name="establishment_id" ${canManage ? '' : 'disabled'}>
                ${establishments.map((item) => `<option value="${item.id}">${item.name}</option>`).join('')}
              </select>
            </label>
            <label class="span-2">Segmento manual<input name="audience" placeholder="Pacientes cronicos con consentimiento vigente" ${canManage ? '' : 'disabled'}></label>
            <label>Plantilla
              <select name="template_id" ${canManage ? '' : 'disabled'}>
                ${templates.map((item) => `<option value="${item.id}">${item.code} · ${item.channel} · ${item.purpose}</option>`).join('')}
              </select>
            </label>
            <label>Encuesta asociada
              <select name="survey_id" ${canManage ? '' : 'disabled'}>
                <option value="">Sin encuesta</option>
                ${surveys.map((item) => `<option value="${item.id}">${item.name}</option>`).join('')}
              </select>
            </label>
            <div class="form-actions span-2"><button type="submit" ${canManage ? '' : 'disabled'}>Crear campana</button></div>
          </form>
        </section>
        <section class="card">
          <div class="section-head"><h2>Operar campana</h2>${badge(canManage ? 'gestion_habilitada' : 'solo_lectura')}</div>
          <form id="approve-campaign-form" class="form-grid">
            <label>Campana
              <select name="campaign_id" ${canManage ? '' : 'disabled'}>
                ${campaigns.map((item) => `<option value="${item.id}">${item.id} · ${item.name}</option>`).join('')}
              </select>
            </label>
            <label class="span-2">Nota aprobacion<input name="approval_note" placeholder="Aprobacion sanitaria" ${canManage ? '' : 'disabled'}></label>
            <div class="form-actions span-2"><button type="submit" ${canManage ? '' : 'disabled'}>Aprobar</button></div>
          </form>
          <form id="schedule-campaign-form" class="form-grid">
            <label>Campana
              <select name="campaign_id" ${canManage ? '' : 'disabled'}>
                ${campaigns.map((item) => `<option value="${item.id}">${item.id} · ${item.name}</option>`).join('')}
              </select>
            </label>
            <label>Programacion<input type="datetime-local" name="scheduled_at" ${canManage ? '' : 'disabled'}></label>
            <label class="span-2">Nota ejecucion<input name="execution_note" placeholder="Envio programado" ${canManage ? '' : 'disabled'}></label>
            <div class="form-actions span-2"><button type="submit" ${canManage ? '' : 'disabled'}>Programar</button></div>
          </form>
          <form id="export-campaign-form" class="form-grid">
            <label>Campana
              <select name="campaign_id" ${canExport ? '' : 'disabled'}>
                ${campaigns.map((item) => `<option value="${item.id}">${item.id} · ${item.name}</option>`).join('')}
              </select>
            </label>
            <label>Finalidad exportacion<input name="purpose" placeholder="seguimiento_operativo" ${canExport ? '' : 'disabled'}></label>
            <div class="form-actions span-2"><button type="submit" ${canExport ? '' : 'disabled'}>Exportar agregado</button></div>
          </form>
        </section>
      </div>
      <section class="card">
        <div class="section-head"><h2>Registrar respuesta de encuesta</h2>${badge(canManage ? 'encuesta' : 'solo_lectura')}</div>
        <form id="survey-response-form" class="form-grid">
          <label>Encuesta
            <select name="survey_id" ${canManage ? '' : 'disabled'}>
              ${surveys.map((item) => `<option value="${item.id}">${item.name}</option>`).join('')}
            </select>
          </label>
          <label>Campana
            <select name="campaign_id" ${canManage ? '' : 'disabled'}>
              ${campaigns.filter((item) => item.survey_id).map((item) => `<option value="${item.id}">${item.id} · ${item.name}</option>`).join('')}
            </select>
          </label>
          <label>Paciente
            <select name="patient_id" ${canManage ? '' : 'disabled'}>
              ${patients.map((item) => `<option value="${item.id}">${item.display_name}</option>`).join('')}
            </select>
          </label>
          <label>Puntaje
            <select name="score" ${canManage ? '' : 'disabled'}>
              ${[1, 2, 3, 4, 5].map((value) => `<option value="${value}">${value}</option>`).join('')}
            </select>
          </label>
          <label>Canal
            <select name="channel" ${canManage ? '' : 'disabled'}>
              ${['telefono', 'sms', 'correo', 'whatsapp'].map((item) => `<option value="${item}">${item}</option>`).join('')}
            </select>
          </label>
          <label class="span-2">Comentario<input name="comment" placeholder="Satisfaccion alta, sin datos clinicos" ${canManage ? '' : 'disabled'}></label>
          <div class="form-actions span-2"><button type="submit" ${canManage ? '' : 'disabled'}>Registrar respuesta</button></div>
        </form>
      </section>
    `;
  },
  sidra() {
    const events = filteredSidraEvents();
    const canManage = rbac().action_access?.sidra_manage;
    const establishments = state.bootstrap.establishments || [];
    return `
      <section class="card notice">
        <h2>SIDRA</h2>
        <p>La cola de integracion permite revisar estado, seguimiento y resolucion de eventos.</p>
      </section>
      <section class="card">
        <div class="section-head"><h2>Cola SIDRA</h2>${badge(events.length)}</div>
        <p class="muted">${canManage ? 'La tabla resume el estado y cada evento se gestiona desde un panel lateral unico.' : 'Tu rol puede revisar el estado de la cola, pero no mutarla.'}</p>
        ${canManage ? `
          <form id="create-sidra-event-form" class="form-grid">
            <label>Tipo<input name="type" value="appointment.manual_sync"></label>
            <label>Entidad
              <select name="entity">
                ${['appointment', 'waitlist', 'contact_case', 'patient', 'manual_batch'].map((item) => `<option value="${item}">${item}</option>`).join('')}
              </select>
            </label>
            <label>Entity ID<input name="entity_id" placeholder="C-0001 o lote-001"></label>
            <label>Establecimiento
              <select name="establishment_id">
                ${establishments.map((item) => `<option value="${item.id}">${item.name}</option>`).join('')}
              </select>
            </label>
            <label>Resultado por defecto
              <select name="simulation_default_result">
                ${['acknowledged', 'failed', 'rejected', 'discrepancy'].map((item) => `<option value="${item}">${item}</option>`).join('')}
              </select>
            </label>
            <label class="span-2">Nota<input name="note" placeholder="Evento para seguimiento operativo"></label>
            <div class="form-actions span-2"><button type="submit">Encolar evento</button></div>
          </form>
        ` : ''}
        <div class="table-wrap scroll-region scroll-region-xl"><table><thead><tr><th>ID</th><th>${sortHeader('sidra', 'event', 'Evento')}</th><th>Entidad</th><th>Establecimiento</th><th>${sortHeader('sidra', 'status', 'Estado')}</th><th>${sortHeader('sidra', 'retries', 'Reintentos')}</th><th>Accion</th></tr></thead><tbody>${events.map((item) => `
          <tr>
            <td>${item.id}</td>
            <td><strong>${item.type}</strong><small class="slot-meta">${item.entity}:${item.entity_id || '-'}</small></td>
            <td>${item.entity}</td>
            <td>${item.establishment_name}</td>
            <td>${badge(item.status)}</td>
            <td>${item.retries}/${item.max_retries}</td>
            <td><button class="slot-action secondary" type="button" data-open-drawer="sidra" data-id="${item.id}">${item.allowed_actions?.process || item.allowed_actions?.retry || item.allowed_actions?.resolve_discrepancy ? 'Gestionar' : 'Ver detalle'}</button></td>
          </tr>
        `).join('')}</tbody></table></div>
      </section>
      <section class="card">
        <div class="section-head"><h2>Alertas de cola</h2>${badge((events.filter((item) => ['retry_pending', 'failed', 'discrepancy', 'rejected'].includes(item.status))).length)}</div>
        <div class="stack">${events.filter((item) => ['retry_pending', 'failed', 'discrepancy', 'rejected'].includes(item.status)).map((item) => `
          <article class="slot">
            <div>
              <strong>${item.id} · ${item.type}</strong>
              <span>${item.establishment_name}</span>
              <small class="slot-meta">${item.last_error || item.discrepancy_note || 'Sin detalle adicional'}</small>
            </div>
            <div class="slot-actions">${badge(item.status)}</div>
          </article>
        `).join('') || '<p class="muted">No hay errores ni discrepancias abiertas.</p>'}</div>
      </section>
    `;
  },
  reports() {
    const reports = filteredReports();
    const establishments = state.bootstrap.establishments || [];
    const services = state.bootstrap.services || [];
    const canExport = rbac().action_access?.reports_export;
    return `
      <section class="card notice">
        <h2>Reportes</h2>
        <p>Consulta, genera y exporta reportes operativos para seguimiento de la gestion.</p>
      </section>
      <section class="card">
        <div class="section-head"><h2>Reportes mensuales persistidos</h2>${badge(reports.length)}</div>
        <div class="table-wrap scroll-region scroll-region-lg"><table><thead><tr><th>ID</th><th>Periodo</th><th>Filtros</th><th>Citas</th><th>Contactos</th><th>SIDRA pendiente</th><th>Privacidad</th></tr></thead><tbody>${reports.map((item) => `<tr><td>${item.id}</td><td>${item.period}</td><td>${[item.filters?.establishment_id || 'todos', item.filters?.service_id || 'todas', item.filters?.channel || 'todos'].join(' / ')}</td><td>${item.totals?.appointments_created || 0}</td><td>${item.totals?.contact_attempts || 0}</td><td>${item.totals?.sidra_pending || 0}</td><td>${badge(item.privacy?.identifiable_export === false ? 'aggregate_only' : 'blocked')}</td></tr>`).join('')}</tbody></table></div>
      </section>
      <section class="card">
          <div class="section-head"><h2>Generar reporte</h2>${badge('reports.read')}</div>
          <form id="create-report-form" class="form-grid">
            <label>Periodo<input name="period" value="2026-07" placeholder="2026-07"></label>
            <label>Establecimiento
              <select name="establishment_id">
                <option value="">Todos</option>
                ${establishments.map((item) => `<option value="${item.id}">${item.name}</option>`).join('')}
              </select>
            </label>
            <label>Prestacion
              <select name="service_id">
                <option value="">Todas</option>
                ${services.map((item) => `<option value="${item.id}">${item.name}</option>`).join('')}
              </select>
            </label>
            <label>Canal
              <select name="channel">
                <option value="">Todos</option>
                ${['telefono', 'sms', 'correo', 'whatsapp', 'meson'].map((item) => `<option value="${item}">${item}</option>`).join('')}
              </select>
            </label>
            <div class="form-actions span-2"><button type="submit">Generar reporte</button></div>
          </form>
          <form id="export-report-form" class="form-grid">
            <label>Periodo<input name="period" value="2026-07" placeholder="2026-07" ${canExport ? '' : 'disabled'}></label>
            <label>Finalidad exportacion<input name="purpose" placeholder="seguimiento_operativo" ${canExport ? '' : 'disabled'}></label>
            <label>Establecimiento
              <select name="establishment_id" ${canExport ? '' : 'disabled'}>
                <option value="">Todos</option>
                ${establishments.map((item) => `<option value="${item.id}">${item.name}</option>`).join('')}
              </select>
            </label>
            <label>Canal
              <select name="channel" ${canExport ? '' : 'disabled'}>
                <option value="">Todos</option>
                ${['telefono', 'sms', 'correo', 'whatsapp', 'meson'].map((item) => `<option value="${item}">${item}</option>`).join('')}
              </select>
            </label>
            <div class="form-actions span-2"><button type="submit" ${canExport ? '' : 'disabled'}>Exportar agregado</button></div>
          </form>
      </section>
    `;
  },
  audit() {
    const query = state.query.trim().toLowerCase();
    const auditRows = sortRows((state.bootstrap.audit || []).filter((item) => !query || [item.actor, item.action, item.detail, item.entity].some((value) => String(value).toLowerCase().includes(query))), state.sortBy.audit, {
      default: (left, right) => compareDate(right.at, left.at),
      recent: (left, right) => compareDate(right.at, left.at),
      actor: (left, right) => compareText(left.actor, right.actor),
      action: (left, right) => compareText(left.action, right.action),
      result: (left, right) => compareText(left.result, right.result)
    });
    return `
      <section class="card">
        <div class="section-head"><h2>Trazabilidad</h2>${badge('audit.view')}</div>
        <p class="muted">Registro cronologico de acciones y resultados.</p>
        <div class="table-wrap scroll-region scroll-region-xl"><table><thead><tr><th>${sortHeader('audit', 'recent', 'Fecha')}</th><th>${sortHeader('audit', 'actor', 'Actor')}</th><th>Rol</th><th>${sortHeader('audit', 'action', 'Accion')}</th><th>${sortHeader('audit', 'result', 'Resultado')}</th><th>Detalle</th></tr></thead><tbody>${auditRows.map((item) => `<tr><td>${item.at}</td><td>${item.actor}</td><td>${item.role}</td><td>${item.action}</td><td>${badge(item.result)}</td><td>${item.detail}</td></tr>`).join('')}</tbody></table></div>
      </section>
    `;
  }
};

function loginCard() {
  return `
    <main class="login-shell" data-auth-state="anonymous">
      <section class="login-panel">
        <div class="login-brand">
          <span class="mark large">QS</span>
          <div>
            <p class="eyebrow">Quilicura Salud</p>
            <h1>Acceso</h1>
            <p class="muted">Ingresa con tus credenciales para acceder a agenda, pacientes, lista de espera y contactabilidad.</p>
          </div>
        </div>
        <form id="login-form" class="login-form">
          <label>
            Usuario
            <input name="username" autocomplete="username" placeholder="admin.comunal" required>
          </label>
          <label>
            Contrasena
            <input name="password" type="password" autocomplete="current-password" placeholder="Ingresa tu clave" required>
          </label>
          <button type="submit" ${state.loginPending ? 'disabled' : ''}>${state.loginPending ? 'Ingresando...' : 'Ingresar'}</button>
        </form>
        <p class="login-message ${state.authMessage ? 'visible' : ''}">${state.authMessage || 'Acceso disponible para usuarios autorizados.'}</p>
      </section>
      <section class="login-help">
        <article class="card">
          <div class="section-head"><h2>Ingreso seguro</h2>${badge('local_access')}</div>
          <p class="muted compact-note">El acceso requiere usuario y clave vigentes. Si no puedes ingresar, solicita apoyo al equipo administrador.</p>
        </article>
        <article class="card">
          <div class="section-head"><h2>Seguridad</h2>${badge('auth_local')}</div>
          <ul class="plain-list">
            <li>Usuario y clave son obligatorios.</li>
            <li>La sesion expira y exige volver a autenticarte.</li>
            <li>La API bloquea por rol, permiso y establecimiento.</li>
            <li>Al cerrar sesion se invalida el acceso activo.</li>
          </ul>
        </article>
      </section>
    </main>
  `;
}

function maybeAutoLogin() {
  if (state.e2eAttempted) {
    return;
  }
  const params = new URLSearchParams(location.search);
  const forcedView = params.get('e2e_view');
  if (forcedView) {
    state.view = forcedView;
  }
  const sessionKeyFromQuery = params.get('e2e_token');
  if (sessionKeyFromQuery) {
    state.e2eAttempted = true;
    const seededAuth = {
      expires_at: params.get('e2e_expires_at') || new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      user: null,
      sessionKey: sessionKeyFromQuery
    };
    state.auth = seededAuth;
    writeAuth(state.auth);
    queueMicrotask(() => {
      loadProtectedApp();
    });
    return;
  }
  if (params.get('e2e_autologin') !== '1') {
    return;
  }
  state.e2eAttempted = true;
  queueMicrotask(() => {
    login(
      params.get('username') || 'admin.comunal',
      params.get('password') || 'Quili.Admin!2026'
    );
  });
}

function renderLogin() {
  app.innerHTML = loginCard();
  const form = document.getElementById('login-form');
  const usernameInput = form?.querySelector('input[name="username"]');
  if (usernameInput && !usernameInput.value) {
    usernameInput.value = readRememberedUsername();
  }
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    login(data.get('username'), data.get('password'));
  });
  maybeAutoLogin();
}

function render() {
  if (!activeSessionKey()) {
    renderLogin();
    return;
  }
  if (state.loading || !state.bootstrap) {
    app.innerHTML = `<main class="loading" data-auth-state="authenticated"><h1>Quilicura Salud</h1><p>Cargando sesion, permisos, pacientes, agenda, lista de espera y contactabilidad...</p></main>`;
    return;
  }
  const content = canView(state.view) ? views[state.view]() : deniedView();
  layout(content);
}

loadProtectedApp();
