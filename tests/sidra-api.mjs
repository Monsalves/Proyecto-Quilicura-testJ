import {
  createAppointmentV1,
  createSidraEventV1,
  listAvailabilityV1,
  listSidraEventsV1,
  loginUser,
  processSidraEventV1,
  resetDatabaseForUser,
  resolveSidraDiscrepancyV1,
  retrySidraEventV1
} from '../src/backend/local-backend.mjs';

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

try {
  const adminLogin = await loginUser('admin.comunal', 'Quili.Admin!2026');
  assert(adminLogin.status === 200, 'sidra api admin login must succeed');

  const reset = await resetDatabaseForUser(adminLogin.auth.token);
  assert(reset.status === 200, 'sidra api reset must succeed');
  const resetToken = reset.payload.auth.token;

  const auditorLogin = await loginUser('auditor.demo', 'Quili.Audit!2026');
  assert(auditorLogin.status === 200, 'sidra api auditor login must succeed after reset');

  const availability = await listAvailabilityV1(resetToken, { establishment_id: 'cesfam-bauza' });
  assert(availability.status === 200, 'sidra availability must succeed');
  const freeSlot = availability.payload.items.find((item) => item.allowed_actions?.book);
  assert(Boolean(freeSlot), 'sidra api test needs a free slot');

  const createAppointment = await createAppointmentV1(resetToken, {
    patient_id: 'P-1001',
    slot_id: freeSlot.id,
    channel: 'telefono',
    note: 'Cita para probar cola SIDRA'
  });
  assert(createAppointment.status === 201, 'appointment create must succeed for sidra api test');
  const appointmentId = createAppointment.payload.appointment?.id;
  assert(Boolean(appointmentId), 'appointment create must return id for sidra api test');

  const sidraList = await listSidraEventsV1(resetToken);
  assert(sidraList.status === 200, 'sidra list must succeed');
  const queuedAppointmentEvent = sidraList.payload.items.find((item) => item.entity_id === appointmentId && item.type === 'appointment.created');
  assert(Boolean(queuedAppointmentEvent), 'appointment create must enqueue sidra event');
  assert(queuedAppointmentEvent.status === 'queued', 'appointment sidra event must start queued');

  const auditorCreateDenied = await createSidraEventV1(auditorLogin.auth.token, {
    type: 'manual.denied',
    entity: 'manual_batch',
    entity_id: 'AUD-001',
    establishment_id: 'direccion-salud',
    simulation_default_result: 'acknowledged',
    payload: { source: 'auditor' }
  });
  assert(auditorCreateDenied.status === 403, 'auditor sidra create must be denied');

  const failedProcess = await processSidraEventV1(resetToken, queuedAppointmentEvent.id, {
    result: 'failed',
    detail: 'Timeout local de SIDRA',
    error_code: 'SIDRA_TIMEOUT'
  });
  assert(failedProcess.status === 200, 'first sidra process must succeed');
  assert(failedProcess.payload.sidra_event?.status === 'retry_pending', 'failed sidra process must move to retry_pending');
  assert(failedProcess.payload.sidra_event?.retries === 1, 'failed sidra process must increment retries');

  const retryRequest = await retrySidraEventV1(resetToken, queuedAppointmentEvent.id, {
    detail: 'Reintento manual desde prueba contractual'
  });
  assert(retryRequest.status === 200, 'sidra retry request must succeed');
  assert(retryRequest.payload.sidra_event?.status === 'retry_pending', 'retry request keeps event in retry_pending');

  const discrepancyProcess = await processSidraEventV1(resetToken, queuedAppointmentEvent.id, {
    result: 'discrepancy',
    detail: 'Datos locales y simulados no coinciden',
    error_code: 'SIDRA_DIFF'
  });
  assert(discrepancyProcess.status === 200, 'sidra discrepancy process must succeed');
  assert(discrepancyProcess.payload.sidra_event?.status === 'discrepancy', 'sidra discrepancy process must move to discrepancy');

  const resolveDiscrepancy = await resolveSidraDiscrepancyV1(resetToken, queuedAppointmentEvent.id, {
    resolution_note: 'Conciliado manualmente con trazabilidad local'
  });
  assert(resolveDiscrepancy.status === 200, 'sidra discrepancy resolve must succeed');
  assert(resolveDiscrepancy.payload.sidra_event?.status === 'acknowledged', 'resolved sidra discrepancy must become acknowledged');

  const createManualEvent = await createSidraEventV1(resetToken, {
    type: 'manual.batch.sync',
    entity: 'manual_batch',
    entity_id: 'LOTE-001',
    establishment_id: 'cesfam-bauza',
    simulation_default_result: 'failed',
    payload: {
      source: 'sidra-api-test'
    }
  });
  assert(createManualEvent.status === 201, 'manual sidra event create must succeed');
  const manualEventId = createManualEvent.payload.sidra_event?.id;
  assert(Boolean(manualEventId), 'manual sidra event create must return id');

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const processed = await processSidraEventV1(resetToken, manualEventId, {
      result: 'failed',
      detail: `Falla simulada ${attempt}`,
      error_code: `FAIL_${attempt}`
    });
    assert(processed.status === 200, `manual sidra process ${attempt} must succeed`);
    if (attempt < 3) {
      assert(processed.payload.sidra_event?.status === 'retry_pending', `manual sidra process ${attempt} must remain retry_pending`);
    } else {
      assert(processed.payload.sidra_event?.status === 'failed', 'manual sidra process 3 must end failed');
    }
  }

  const relogin = await loginUser('admin.comunal', 'Quili.Admin!2026');
  assert(relogin.status === 200, 'relogin after sidra persistence must succeed');

  const persistedAck = await listSidraEventsV1(relogin.auth.token, { status: 'acknowledged' });
  assert(persistedAck.status === 200, 'persisted acknowledged sidra list must succeed');
  assert(persistedAck.payload.items.some((item) => item.id === queuedAppointmentEvent.id), 'acknowledged sidra event must persist');

  const persistedFailed = await listSidraEventsV1(relogin.auth.token, { status: 'failed' });
  assert(persistedFailed.status === 200, 'persisted failed sidra list must succeed');
  assert(persistedFailed.payload.items.some((item) => item.id === manualEventId), 'failed sidra event must persist');

  if (!process.exitCode) {
    console.log('sidra api contract pass');
  }
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
