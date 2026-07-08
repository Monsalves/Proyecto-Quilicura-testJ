
const STORAGE_KEY = 'quilicura-product-web-v0014';

const seed = {
  user: { name: 'Camila Rojas', role: 'Administrador comunal', facility: 'CESFAM Quilicura' },
  patients: [
    { id: 'P-1001', rut: '11.111.111-1', name: 'Paciente Demo Uno', age: 42, phone: '+56 9 4000 1001', sector: 'Lo Marcoleta', risk: 'GES activo', contactable: true },
    { id: 'P-1002', rut: '22.222.222-2', name: 'Paciente Demo Dos', age: 67, phone: '+56 9 4000 1002', sector: 'Valle Lo Campino', risk: 'Adulto mayor', contactable: true },
    { id: 'P-1003', rut: '33.333.333-3', name: 'Paciente Demo Tres', age: 29, phone: '+56 9 4000 1003', sector: 'San Luis', risk: 'Control pendiente', contactable: false }
  ],
  slots: [
    { id: 'S-01', day: 'Lun 06', time: '09:00', professional: 'Dra. M. Silva', service: 'Medicina general', status: 'disponible' },
    { id: 'S-02', day: 'Lun 06', time: '09:30', professional: 'Dra. M. Silva', service: 'Medicina general', status: 'reservado' },
    { id: 'S-03', day: 'Lun 06', time: '10:00', professional: 'Enf. P. Soto', service: 'Control cardiovascular', status: 'disponible' },
    { id: 'S-04', day: 'Mar 07', time: '11:00', professional: 'Mat. A. Vega', service: 'Matroneria', status: 'bloqueado' },
    { id: 'S-05', day: 'Mie 08', time: '08:30', professional: 'Dra. M. Silva', service: 'Medicina general', status: 'disponible' },
    { id: 'S-06', day: 'Jue 09', time: '15:00', professional: 'Enf. P. Soto', service: 'Control cardiovascular', status: 'disponible' }
  ],
  appointments: [
    { id: 'C-501', patientId: 'P-1001', slotId: 'S-02', status: 'confirmada', channel: 'telefono', note: 'Confirmada por contact center' }
  ],
  waitlist: [
    { id: 'LE-701', patientId: 'P-1002', service: 'Control cardiovascular', priority: 'alta', days: 38, status: 'en espera' },
    { id: 'LE-702', patientId: 'P-1003', service: 'Medicina general', priority: 'media', days: 12, status: 'en espera' }
  ],
  campaigns: [
    { id: 'CAM-21', name: 'Recordatorio control cardiovascular', audience: 'Pacientes con riesgo alto', channel: 'SMS simulado', status: 'borrador', sent: 0 },
    { id: 'CAM-22', name: 'Encuesta post atencion', audience: 'Citas cerradas ultimos 7 dias', channel: 'WhatsApp simulado', status: 'lista', sent: 18 }
  ],
  sidra: [
    { id: 'EV-9001', type: 'appointment.created', entity: 'C-501', status: 'acknowledged', retries: 0 },
    { id: 'EV-9002', type: 'patient.updated', entity: 'P-1001', status: 'queued', retries: 0 },
    { id: 'EV-9003', type: 'integration.discrepancy', entity: 'S-04', status: 'discrepancy', retries: 1 }
  ],
  audit: [
    { at: '2026-07-06 08:45', actor: 'sistema', action: 'seed.local.loaded', detail: 'Datos demo no productivos cargados' },
    { at: '2026-07-06 08:47', actor: 'Camila Rojas', action: 'sidra.real.blocked', detail: 'Contrato real no aprobado' }
  ]
};

let state = loadState();
let currentView = 'dashboard';
let query = '';

const nav = [
  ['dashboard', 'Inicio'], ['agenda', 'Agenda'], ['patients', 'Pacientes'], ['waitlist', 'Lista espera'],
  ['contact', 'Contactabilidad'], ['campaigns', 'Campanas'], ['sidra', 'SIDRA simulado'], ['reports', 'Reportes'], ['audit', 'Auditoria']
];

function clone(value){ return JSON.parse(JSON.stringify(value)); }
function loadState(){
  const raw = localStorage.getItem(STORAGE_KEY);
  if(!raw){ return clone(seed); }
  try { return { ...clone(seed), ...JSON.parse(raw) }; } catch { return clone(seed); }
}
function persist(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function now(){ return new Date().toISOString().slice(0,16).replace('T',' '); }
function audit(action, detail){ state.audit.unshift({ at: now(), actor: state.user.name, action, detail }); state.audit = state.audit.slice(0,80); persist(); }
function patient(id){ return state.patients.find(p => p.id === id) || { name: 'Sin paciente', rut: '-' }; }
function slot(id){ return state.slots.find(s => s.id === id) || { day: '-', time: '-', professional: '-', service: '-' }; }
function availableSlots(){ return state.slots.filter(s => s.status === 'disponible'); }
function statusClass(value){ return String(value).toLowerCase().replaceAll(' ', '-'); }
function matches(text){ return String(text).toLowerCase().includes(query.toLowerCase()); }

function shell(){
  document.getElementById('app').innerHTML = `
    <aside class="sidebar">
      <div class="brand"><span class="mark">QS</span><div><strong>Quilicura Salud</strong><small>Operacion local simulada</small></div></div>
      <nav>${nav.map(([id,label]) => `<button class="nav ${currentView===id?'active':''}" data-nav="${id}">${label}</button>`).join('')}</nav>
      <div class="safe-box"><strong>Modo seguro</strong><span>SIDRA real off</span><span>Datos productivos off</span><span>Deploy off</span></div>
    </aside>
    <main class="main">
      <header class="topbar">
        <div><h1>${nav.find(n=>n[0]===currentView)?.[1] || 'Quilicura Salud'}</h1><p>${state.user.facility} · ${state.user.role}</p></div>
        <div class="actions"><input id="search" placeholder="Buscar paciente, cita o evento" value="${query}"><button data-action="reset">Restaurar demo</button></div>
      </header>
      <section id="view"></section>
    </main>`;
  document.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => { currentView = b.dataset.nav; render(); }));
  document.getElementById('search').addEventListener('input', e => { query = e.target.value; renderView(); });
  document.querySelector('[data-action="reset"]').addEventListener('click', () => { state = clone(seed); persist(); audit('demo.reset', 'Estado local restaurado'); render(); });
  renderView();
}

function render(){ shell(); }
function renderView(){ document.getElementById('view').innerHTML = views[currentView](); bindActions(); }

const views = {
  dashboard(){
    const confirmed = state.appointments.filter(a => a.status !== 'cancelada').length;
    const waitingHigh = state.waitlist.filter(w => w.priority === 'alta').length;
    const sidraPending = state.sidra.filter(e => ['queued','retry_pending','discrepancy'].includes(e.status)).length;
    return `${cards([
      ['Citas activas', confirmed, 'Agenda local con auditoria'],
      ['Cupos disponibles', availableSlots().length, 'Bloquea doble reserva'],
      ['Espera alta', waitingHigh, 'Priorizacion visible'],
      ['Eventos SIDRA', sidraPending, 'Cola simulada local']
    ])}
    <div class="split"><section class="panel"><h2>Agenda de hoy</h2>${agendaList(state.slots.slice(0,4))}</section><section class="panel"><h2>Trabajo pendiente</h2>${taskList()}</section></div>`;
  },
  agenda(){
    return `<section class="panel"><div class="panel-head"><h2>Reservar cita</h2><button data-action="createAppointment">Crear cita demo</button></div>${agendaList(state.slots)}</section>
    <section class="panel"><h2>Citas</h2>${appointmentsTable()}</section>`;
  },
  patients(){
    const rows = state.patients.filter(p => matches(p.name) || matches(p.rut) || matches(p.sector)).map(p =>
      `<tr><td><strong>${p.name}</strong><small>${p.rut}</small></td><td>${p.age}</td><td>${p.sector}</td><td>${p.risk}</td><td>${badge(p.contactable?'contactable':'no contactable')}</td><td><button data-action="toggleContact" data-id="${p.id}">Cambiar</button></td></tr>`).join('');
    return `<section class="panel"><div class="panel-head"><h2>Pacientes demo</h2><button data-action="addPatient">Nuevo paciente demo</button></div><table><thead><tr><th>Paciente</th><th>Edad</th><th>Sector</th><th>Riesgo</th><th>Estado</th><th></th></tr></thead><tbody>${rows}</tbody></table></section>`;
  },
  waitlist(){
    const rows = state.waitlist.map(w => `<tr><td><strong>${patient(w.patientId).name}</strong><small>${w.id}</small></td><td>${w.service}</td><td>${badge(w.priority)}</td><td>${w.days} dias</td><td>${badge(w.status)}</td><td><button data-action="offerSlot" data-id="${w.id}">Ofertar cupo</button></td></tr>`).join('');
    return `<section class="panel"><div class="panel-head"><h2>Lista de espera inteligente</h2><button data-action="addWaitlist">Agregar solicitud</button></div><table><thead><tr><th>Paciente</th><th>Prestacion</th><th>Prioridad</th><th>Antiguedad</th><th>Estado</th><th></th></tr></thead><tbody>${rows}</tbody></table></section>`;
  },
  contact(){
    return `<div class="split"><section class="panel"><h2>Bandeja de contacto</h2>${state.patients.map(p => `<article class="contact"><div><strong>${p.name}</strong><span>${p.phone} · ${p.sector}</span></div><button data-action="sendReminder" data-id="${p.id}" ${!p.contactable?'disabled':''}>Enviar recordatorio</button></article>`).join('')}</section><section class="panel"><h2>Asistente espanol / creole</h2><div class="assistant"><p>Consulta demo: Necesito cambiar mi hora de control.</p><strong>Respuesta sugerida</strong><p>Podemos revisar cupos disponibles. Si requiere creole, se escala a apoyo humano simulado.</p><button data-action="escalateCreole">Escalar creole</button></div></section></div>`;
  },
  campaigns(){
    const rows = state.campaigns.map(c => `<tr><td><strong>${c.name}</strong><small>${c.id}</small></td><td>${c.audience}</td><td>${c.channel}</td><td>${badge(c.status)}</td><td>${c.sent}</td><td><button data-action="sendCampaign" data-id="${c.id}">Enviar simulado</button></td></tr>`).join('');
    return `<section class="panel"><div class="panel-head"><h2>Campanas y encuestas</h2><button data-action="newCampaign">Nueva campana</button></div><table><thead><tr><th>Campana</th><th>Audiencia</th><th>Canal</th><th>Estado</th><th>Enviados</th><th></th></tr></thead><tbody>${rows}</tbody></table></section>`;
  },
  sidra(){
    const rows = state.sidra.map(e => `<tr><td>${e.id}</td><td>${e.type}</td><td>${e.entity}</td><td>${badge(e.status)}</td><td>${e.retries}</td><td><button data-action="retrySidra" data-id="${e.id}">Reintentar</button></td></tr>`).join('');
    return `<section class="panel danger-panel"><h2>Integracion SIDRA simulada</h2><p>La cola permite auditar eventos y discrepancias sin escritura externa. Produccion real permanece bloqueada.</p></section><section class="panel"><table><thead><tr><th>ID</th><th>Evento</th><th>Entidad</th><th>Estado</th><th>Reintentos</th><th></th></tr></thead><tbody>${rows}</tbody></table></section>`;
  },
  reports(){
    return `${cards([
      ['Citas creadas', state.appointments.length, 'Periodo local'],
      ['Ofertas espera', state.waitlist.filter(w=>w.status.includes('oferta')).length, 'Sin envio real'],
      ['Contactos simulados', state.audit.filter(a=>a.action.includes('contact')).length, 'Auditados'],
      ['Eventos integracion', state.sidra.length, 'Contrato simulado']
    ])}<section class="panel"><h2>Reporte mensual simulado</h2><div class="report"><div><span>Exportacion identificable</span>${badge('bloqueada')}</div><div><span>Datos productivos</span>${badge('false')}</div><div><span>Revision juridica</span>${badge('pendiente')}</div><div><span>Ambiente productivo</span>${badge('no aprobado')}</div></div></section>`;
  },
  audit(){
    return `<section class="panel"><h2>Auditoria local append-only</h2><table><thead><tr><th>Fecha</th><th>Actor</th><th>Accion</th><th>Detalle</th></tr></thead><tbody>${state.audit.map(a => `<tr><td>${a.at}</td><td>${a.actor}</td><td>${a.action}</td><td>${a.detail}</td></tr>`).join('')}</tbody></table></section>`;
  }
};

function cards(items){ return `<div class="cards">${items.map(([title,value,meta]) => `<article class="metric-card"><span>${title}</span><strong>${value}</strong><small>${meta}</small></article>`).join('')}</div>`; }
function badge(value){ return `<span class="badge ${statusClass(value)}">${value}</span>`; }
function agendaList(slots){ return `<div class="agenda-grid">${slots.map(s => `<article class="slot ${s.status}"><div><strong>${s.day} ${s.time}</strong><span>${s.professional}</span><small>${s.service}</small></div>${badge(s.status)}</article>`).join('')}</div>`; }
function appointmentsTable(){
  const rows = state.appointments.map(a => { const p = patient(a.patientId), s = slot(a.slotId); return `<tr><td><strong>${a.id}</strong><small>${p.name}</small></td><td>${s.day} ${s.time}</td><td>${s.service}</td><td>${a.channel}</td><td>${badge(a.status)}</td><td><button data-action="cancelAppointment" data-id="${a.id}">Anular</button></td></tr>`; }).join('');
  return `<table><thead><tr><th>Cita</th><th>Hora</th><th>Prestacion</th><th>Canal</th><th>Estado</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}
function taskList(){
  return `<ul class="tasks"><li>Validar discrepancia SIDRA S-04</li><li>Ofertar cupo a espera LE-701</li><li>Revisar pacientes no contactables</li><li>Emitir reporte mensual simulado</li></ul>`;
}

function bindActions(){ document.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', () => actions[btn.dataset.action]?.(btn.dataset.id))); }
const actions = {
  createAppointment(){
    const free = availableSlots()[0]; const p = state.patients[1];
    if(!free){ audit('appointment.blocked', 'No hay cupos disponibles'); return render(); }
    free.status = 'reservado';
    const id = `C-${600 + state.appointments.length}`;
    state.appointments.push({ id, patientId: p.id, slotId: free.id, status: 'confirmada', channel: 'meson', note: 'Creada localmente' });
    state.sidra.unshift({ id: `EV-${9100 + state.sidra.length}`, type: 'appointment.created', entity: id, status: 'queued', retries: 0 });
    audit('appointment.created', `${id} para ${p.name}`); persist(); render();
  },
  cancelAppointment(id){
    const item = state.appointments.find(a => a.id === id); if(!item) return;
    item.status = 'cancelada'; const s = state.slots.find(x => x.id === item.slotId); if(s) s.status = 'disponible';
    audit('appointment.cancelled', `${id} anulado con cupo liberado`); persist(); render();
  },
  addPatient(){
    const id = `P-${1001 + state.patients.length}`;
    state.patients.push({ id, rut: '44.444.444-4', name: `Paciente Demo ${state.patients.length + 1}`, age: 35, phone: '+56 9 4000 2000', sector: 'Quilicura centro', risk: 'Ingreso demo', contactable: true });
    audit('patient.created', `${id} creado como dato demo`); persist(); render();
  },
  toggleContact(id){ const p = state.patients.find(x => x.id === id); if(p){ p.contactable = !p.contactable; audit('patient.contactability.updated', `${p.name}: ${p.contactable}`); persist(); render(); } },
  addWaitlist(){ const p = state.patients[0]; state.waitlist.push({ id: `LE-${710 + state.waitlist.length}`, patientId: p.id, service: 'Medicina general', priority: 'media', days: 0, status: 'en espera' }); audit('waitlist.created', `Solicitud agregada para ${p.name}`); persist(); render(); },
  offerSlot(id){ const w = state.waitlist.find(x => x.id === id); if(w){ w.status = 'oferta enviada simulada'; audit('waitlist.offer.simulated', `${id} con canal local`); persist(); render(); } },
  sendReminder(id){ const p = patient(id); audit('contact.reminder.simulated', `Recordatorio local para ${p.name}`); persist(); render(); },
  escalateCreole(){ audit('assistant.creole.escalated', 'Escalamiento humano simulado creado'); persist(); render(); },
  newCampaign(){ state.campaigns.push({ id: `CAM-${30 + state.campaigns.length}`, name: 'Nueva campana demo', audience: 'Segmento autorizado', channel: 'SMS simulado', status: 'borrador', sent: 0 }); audit('campaign.created', 'Campana demo creada'); persist(); render(); },
  sendCampaign(id){ const c = state.campaigns.find(x => x.id === id); if(c){ c.status = 'enviada simulada'; c.sent += 12; audit('campaign.sent.simulated', `${c.id} enviada sin proveedor externo`); persist(); render(); } },
  retrySidra(id){ const e = state.sidra.find(x => x.id === id); if(e){ e.retries += 1; e.status = e.status === 'discrepancy' ? 'retry_pending' : 'acknowledged'; audit('sidra.retry.simulated', `${id} reintentado localmente`); persist(); render(); } }
};

render();
