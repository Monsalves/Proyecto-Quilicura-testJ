import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import {
  BrowserSession,
  assert,
  captureScreenshot,
  delay,
  evaluate,
  navigate,
  setViewport,
  startChrome,
  stopChrome,
  waitForFunction
} from './browser-cdp.mjs';

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const chromePort = 9223;
const evidenceDir = join(workspaceRoot, 'evidence');
const visualDir = join(evidenceDir, 'visual');
const fixturePath = join(evidenceDir, 'ui-uiux-v0029-fixture.html');

const bootstrap = {
  runtime: {
    version: 'v0029',
    phase: 'UI Refactor - Responsive y Jerarquia Visual',
    sidra_mode: 'simulated',
    target: 'local_product_ready_increment'
  },
  current_user: {
    username: 'admin.comunal',
    display_name: 'Admin Comunal',
    role: 'Administrador comunal',
    facility: 'Quilicura'
  },
  summary: {
    active_patients: 3,
    managed_patients: 3,
    active_appointments: 2,
    available_slots: 3,
    audit_entries: 6
  },
  rbac: {
    role: { label: 'Administrador comunal' },
    permissions: ['agenda.read', 'agenda.write', 'patients.read', 'patients.write', 'waitlist.read', 'waitlist.write', 'contact.read', 'contact.write'],
    allowed_establishments: [
      { id: 'cesfam-bauza', name: 'CESFAM Bauza' },
      { id: 'cesfam-quilicura', name: 'CESFAM Quilicura' }
    ],
    view_access: {
      dashboard: true,
      agenda: true,
      patients: true,
      waitlist: true,
      contact: true,
      campaigns: true,
      sidra: true,
      reports: true,
      audit: true,
      contract: true
    },
    permissions_catalog: [
      { id: 'agenda.write', label: 'Agenda escritura' },
      { id: 'patients.write', label: 'Pacientes escritura' },
      { id: 'waitlist.write', label: 'Espera escritura' },
      { id: 'contact.write', label: 'Contactabilidad escritura' }
    ],
    action_access: {
      template_manage: true,
      campaign_manage: true,
      campaign_export: true,
      sidra_manage: true,
      reports_export: true,
      backup_manage: true
    },
    scope_mode: 'comunal'
  },
  establishments: [
    { id: 'cesfam-bauza', name: 'CESFAM Bauza' },
    { id: 'cesfam-quilicura', name: 'CESFAM Quilicura' }
  ],
  services: [
    { id: 'SV-001', name: 'Morbilidad adulto', establishment_id: 'cesfam-bauza', establishment_name: 'CESFAM Bauza' },
    { id: 'SV-002', name: 'Control cardiovascular', establishment_id: 'cesfam-bauza', establishment_name: 'CESFAM Bauza' },
    { id: 'SV-003', name: 'Salud mental', establishment_id: 'cesfam-quilicura', establishment_name: 'CESFAM Quilicura' }
  ],
  patients: [
    {
      id: 'P-1001',
      display_name: 'Maria Perez',
      legal_name: 'Maria Perez Rojas',
      social_name: 'Maria Perez',
      rut: '11.111.111-1',
      age: 42,
      status: 'activo',
      identifier_kind: 'definitive',
      birth_date: '1984-01-18',
      establishment_id: 'cesfam-bauza',
      establishment_name: 'CESFAM Bauza',
      sector: 'Sector 2',
      risk: 'cronico',
      notes: 'Seguimiento preventivo.',
      allowed_actions: { manage: true },
      preferences: {
        preferred_channel: 'telefono',
        language: 'espanol',
        allow_non_urgent: true,
        notes: 'Llamar en jornada AM.'
      },
      contacts: [
        { id: 'C-1', label: 'Principal', type: 'telefono', channel: 'telefono', value: '+56 9 4000 1111', verified: true, active: true, excluded_from_non_urgent: false }
      ],
      representatives: [
        { id: 'R-1', legal_name: 'Carlos Perez', relation: 'Hijo', phone: '+56 9 4000 2222', verified: true, status: 'activo', notes: '' }
      ],
      consents: [
        { id: 'K-1', purpose: 'recordatorio_cita', channel_scope: ['telefono', 'sms'], status: 'vigente', granted_at: '2026-07-01', source: 'gestion_ui', notes: '' }
      ]
    }
  ],
  slots: [
    { id: 'S-01', day: '2026-07-08', time: '09:00', service: 'Morbilidad adulto', service_name: 'Morbilidad adulto', service_id: 'SV-001', professional: 'Dra. Soto', professional_name: 'Dra. Soto', establishment_id: 'cesfam-bauza', establishment_name: 'CESFAM Bauza', status: 'disponible', allowed_actions: { book: true, block: true } },
    { id: 'S-02', day: '2026-07-08', time: '09:20', service: 'Morbilidad adulto', service_name: 'Morbilidad adulto', service_id: 'SV-001', professional: 'Dra. Soto', professional_name: 'Dra. Soto', establishment_id: 'cesfam-bauza', establishment_name: 'CESFAM Bauza', status: 'disponible', allowed_actions: { book: true, block: true } },
    { id: 'S-03', day: '2026-07-08', time: '10:00', service: 'Salud mental', service_name: 'Salud mental', service_id: 'SV-003', professional: 'Ps. Diaz', professional_name: 'Ps. Diaz', establishment_id: 'cesfam-quilicura', establishment_name: 'CESFAM Quilicura', status: 'disponible', allowed_actions: { book: true, block: true } }
  ],
  appointments: [
    {
      id: 'A-100',
      patient_name: 'Maria Perez',
      service_name: 'Morbilidad adulto',
      professional_name: 'Dra. Soto',
      slot_label: '2026-07-08 09:00',
      slotId: 'S-01',
      establishment_id: 'cesfam-bauza',
      status: 'confirmada',
      channel: 'telefono',
      allowed_actions: { confirm: true, cancel: true, reprogram: true },
      history: [
        { at: '2026-07-07 09:00', action: 'created', from_status: '-', to_status: 'agendada', detail: 'Cita creada' },
        { at: '2026-07-07 09:10', action: 'confirmed', from_status: 'agendada', to_status: 'confirmada', detail: 'Confirmada por telefono' }
      ]
    }
  ],
  waitlist: [
    {
      id: 'W-100',
      patient_name: 'Maria Perez',
      service: 'Salud mental',
      service_id: 'SV-003',
      establishment_name: 'CESFAM Quilicura',
      status: 'activa',
      priority: 'alta',
      priority_rule: 'RL-01',
      requested_days: 12,
      allowed_actions: { offer: true, resolve_offer: true, close: true },
      active_offer: {
        id: 'OF-10',
        status: 'pendiente',
        slot_label: '2026-07-08 10:00',
        expires_at: '2026-07-08T12:00:00Z'
      },
      events: [
        { at: '2026-07-05 08:00', type: 'created', rule_applied: 'RL-01', detail: 'Ingreso sin cupo' },
        { at: '2026-07-07 11:00', type: 'offered', rule_applied: 'RL-01', detail: 'Oferta temporal' }
      ]
    }
  ],
  contact_templates: [
    { id: 'TPL-0001', code: 'TPL-0001', version: 1, name: 'Recordatorio', channel: 'telefono', purpose: 'recordatorio_cita', language: 'espanol', status: 'active', contains_sensitive_detail: false }
  ],
  contact_messages: [],
  contact_cases: [
    {
      id: 'CC-100',
      patient_name: 'Maria Perez',
      purpose: 'recordatorio_cita',
      establishment_name: 'CESFAM Bauza',
      status: 'abierto',
      attempt_count: 2,
      channel_count: 2,
      allowed_actions: { close_no_contact: true },
      attempts: [
        { id: 'MSG-2', created_at: '2026-07-07 10:20', channel: 'telefono', status: 'responded', result: 'success', preview: 'Paciente confirma.' },
        { id: 'MSG-1', created_at: '2026-07-07 09:40', channel: 'sms', status: 'delivered', result: 'success', preview: 'Recordatorio enviado.' }
      ]
    }
  ],
  sidra: [],
  monthly_reports: [],
  backups: [],
  audit: [],
  legacy_debt: ['Persistencia productiva sigue fuera de alcance.', 'SIDRA real permanece deshabilitado.']
};

async function click(browser, sessionId, selector) {
  const result = await evaluate(browser, sessionId, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return 'missing';
    node.click();
    return 'clicked';
  })()`);
  assert(result === 'clicked', `missing clickable selector ${selector}`);
}

async function fillField(browser, sessionId, selector, value) {
  const result = await evaluate(browser, sessionId, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return 'missing';
    node.focus();
    node.value = ${JSON.stringify(value)};
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  assert(result === 'ok', `missing form field ${selector}`);
}

async function submitForm(browser, sessionId, selector) {
  const result = await evaluate(browser, sessionId, `(() => {
    const form = document.querySelector(${JSON.stringify(selector)});
    if (!form) return 'missing';
    form.requestSubmit();
    return 'submitted';
  })()`);
  assert(result === 'submitted', `missing form ${selector}`);
}

async function assertNoHorizontalOverflow(browser, sessionId, width, viewId) {
  await setViewport(browser, sessionId, width, 844, true);
  await delay(200);
  const metrics = await evaluate(browser, sessionId, `(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
  }))()`);
  assert(metrics.scrollWidth <= metrics.innerWidth, `horizontal overflow detected in ${viewId}: ${metrics.scrollWidth} > ${metrics.innerWidth}`);
}

async function buildFixture() {
  const appJs = pathToFileURL(join(workspaceRoot, 'src/frontend/app.js')).href;
  const stylesCss = pathToFileURL(join(workspaceRoot, 'src/frontend/styles.css')).href;
  const html = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>UI UX v0029 Fixture</title>
    <link rel="stylesheet" href="${stylesCss}">
  </head>
  <body>
    <div id="app"></div>
    <script>
      const bootstrap = ${JSON.stringify(bootstrap)};
      const auth = {
        sessionKey: 'fixture_session',
        expires_at: '2026-07-08T12:00:00.000Z',
        user: bootstrap.current_user
      };
      window.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input.url;
        const path = new URL(url, 'http://fixture.local').pathname;
        if (path === '/api/auth/login') {
          return new Response(JSON.stringify({ auth, bootstrap, message: 'Sesion iniciada.' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (path === '/health') {
          return new Response(JSON.stringify({ status: 'ok', backend: 'mock_uiux', storage: 'fixture', authorization: 'rbac' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (path === '/api/bootstrap') {
          return new Response(JSON.stringify(bootstrap), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (path === '/api/demo/reset') {
          return new Response(JSON.stringify({ auth, bootstrap }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ error: 'not_implemented' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      };
    </script>
    <script type="module" src="${appJs}"></script>
  </body>
</html>`;
  await writeFile(fixturePath, html, 'utf8');
  return pathToFileURL(fixturePath).href;
}

let chrome;
let browser;

try {
  await mkdir(visualDir, { recursive: true });
  const fixtureUrl = await buildFixture();
  chrome = await startChrome({ port: chromePort, width: 1440, height: 960 });
  browser = new BrowserSession(chrome.websocketUrl);
  await browser.connect();
  const sessionId = await browser.newPage();

  await setViewport(browser, sessionId, 1440, 960, false);
  await navigate(browser, sessionId, fixtureUrl);
  await waitForFunction(browser, sessionId, "Boolean(document.querySelector('#login-form'))", 'login form not rendered');

  await fillField(browser, sessionId, '#login-form input[name="username"]', 'admin.comunal');
  await fillField(browser, sessionId, '#login-form input[name="password"]', 'Quili.Admin!2026');
  await submitForm(browser, sessionId, '#login-form');
  await waitForFunction(browser, sessionId, "Boolean(document.querySelector('#logout'))", 'logout button not visible after login');

  const scenarios = [
    { view: 'patients', title: 'pacientes', openSelector: '[data-open-modal="patient-create"]', modalSelector: '[data-modal-kind="patient-create"]', drawerButton: '[data-open-drawer="patient"]', drawerSelector: '[data-drawer-kind="patient"]' },
    { view: 'agenda', title: 'agenda', openSelector: '[data-open-modal="appointment-create"]', modalSelector: '[data-modal-kind="appointment-create"]', drawerButton: '[data-open-drawer="appointment"]', drawerSelector: '[data-drawer-kind="appointment"]' },
    { view: 'waitlist', title: 'lista espera', openSelector: '[data-open-modal="waitlist-create"]', modalSelector: '[data-modal-kind="waitlist-create"]', drawerButton: '[data-open-drawer="waitlist"]', drawerSelector: '[data-drawer-kind="waitlist"]' },
    { view: 'contact', title: 'contactabilidad', openSelector: '[data-open-modal="contact-template-create"]', modalSelector: '[data-modal-kind="contact-template-create"]', drawerButton: '[data-open-drawer="contact-case"]', drawerSelector: '[data-drawer-kind="contact-case"]' }
  ];

  for (const scenario of scenarios) {
    await click(browser, sessionId, `button[data-view="${scenario.view}"]`);
    await waitForFunction(browser, sessionId, `document.querySelector('h1')?.textContent?.toLowerCase().includes(${JSON.stringify(scenario.title)})`, `view ${scenario.view} did not render`);
    await click(browser, sessionId, scenario.openSelector);
    await waitForFunction(browser, sessionId, `Boolean(document.querySelector(${JSON.stringify(scenario.modalSelector)}))`, `modal did not open for ${scenario.view}`);
    await click(browser, sessionId, `${scenario.modalSelector} [data-close-overlay]`);
    await waitForFunction(browser, sessionId, `!document.querySelector(${JSON.stringify(scenario.modalSelector)})`, `modal did not close for ${scenario.view}`);
    await click(browser, sessionId, scenario.drawerButton);
    await waitForFunction(browser, sessionId, `Boolean(document.querySelector(${JSON.stringify(scenario.drawerSelector)}))`, `drawer did not open for ${scenario.view}`);
    await click(browser, sessionId, `${scenario.drawerSelector} [data-close-overlay]`);
    await waitForFunction(browser, sessionId, `!document.querySelector(${JSON.stringify(scenario.drawerSelector)})`, `drawer did not close for ${scenario.view}`);
    await assertNoHorizontalOverflow(browser, sessionId, 390, scenario.view);
  }

  await setViewport(browser, sessionId, 390, 844, true);
  await click(browser, sessionId, 'button[data-view="patients"]');
  await waitForFunction(browser, sessionId, "Boolean(document.querySelector('[data-open-drawer=\"patient\"]'))", 'patients list not ready for mobile screenshot');
  await captureScreenshot(browser, sessionId, join(visualDir, 'mobile-uiux-v0029.png'));

  console.log(JSON.stringify({
    status: 'pass',
    version: 'v0029',
    checked_views: scenarios.map((item) => item.view),
    screenshot: 'evidence/visual/mobile-uiux-v0029.png'
  }, null, 2));
} catch (error) {
  if (String(error.message || '').includes('chrome remote debugging did not become ready')) {
    console.log(JSON.stringify({
      status: 'skipped',
      version: 'v0029',
      reason: 'chrome_cdp_unavailable_in_current_environment'
    }, null, 2));
    process.exitCode = 0;
  } else {
    console.error(`FAIL: ${error.message}`);
    if (chrome?.stderrRef?.()) {
      console.error(chrome.stderrRef());
    }
    process.exitCode = 1;
  }
} finally {
  if (browser) {
    await browser.close();
  }
  await stopChrome(chrome);
  await delay(250);
}
