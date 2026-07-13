import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createSqliteDatabase } from '../src/backend/sqlite-store.mjs';

function parseArgs(argv) {
  const options = {
    input: 'data/seed-r11-base.json',
    seedOutput: 'data/seed-v0031.json',
    dbOutput: 'data/quilicura.sqlite',
    summary: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') {
      options.input = argv[index + 1];
      index += 1;
    } else if (arg === '--seed-output') {
      options.seedOutput = argv[index + 1];
      index += 1;
    } else if (arg === '--db-output') {
      options.dbOutput = argv[index + 1];
      index += 1;
    } else if (arg === '--summary') {
      options.summary = true;
    }
  }

  return options;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = Math.imul(value ^ value >>> 15, 1 | value);
    next ^= next + Math.imul(next ^ next >>> 7, 61 | next);
    return ((next ^ next >>> 14) >>> 0) / 4294967296;
  };
}

function pick(items, index) {
  return items[index % items.length];
}

function pad(number, size = 4) {
  return String(number).padStart(size, '0');
}

function computeRutDv(number) {
  const digits = String(number).replace(/\D/g, '');
  let factor = 2;
  let sum = 0;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    sum += Number(digits[index]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const remainder = 11 - (sum % 11);
  if (remainder === 11) {
    return '0';
  }
  if (remainder === 10) {
    return 'K';
  }
  return String(remainder);
}

function formatRut(number) {
  const digits = String(number).replace(/\D/g, '');
  const body = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${body}-${computeRutDv(digits)}`;
}

function isoDate(offsetDays, hour, minute = 0) {
  const base = Date.UTC(2030, 6, 1 + offsetDays, hour, minute, 0, 0);
  return new Date(base).toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createPatientGenerators() {
  return {
    firstNames: ['Patricia', 'Marcela', 'Andrea', 'Valentina', 'Camila', 'Rosa', 'Evelyn', 'Yasna', 'Mauricio', 'Luis', 'Jorge', 'Daniela', 'Josefa', 'Karina', 'Mario', 'Rene', 'Paula', 'Sebastian', 'Catalina', 'Ignacio', 'Fernanda', 'Cristobal', 'Monica', 'Esteban', 'Lorena', 'Natalia', 'Matias', 'Belen'],
    lastNames: ['Mella', 'Rojas', 'Herrera', 'Silva', 'Soto', 'Munoz', 'Araya', 'Lagos', 'Bravo', 'Pizarro', 'Leiva', 'Guzman', 'Saez', 'Morales', 'Caceres', 'Venegas', 'Farias', 'Opazo', 'Carrasco', 'Navarrete', 'Contreras', 'Bustamante', 'Palma', 'Sepulveda', 'Vidal', 'Henriquez'],
    sectors: ['Lo Marcoleta', 'San Luis Norte', 'Villa Pucara', 'Valle Lo Campino', 'Parque Central', 'Santa Luisa', 'Villa Esperanza', 'Altos de Quilicura', 'Los Presidentes', 'El Mañio'],
    risks: ['GES activo', 'cronico compensado', 'riesgo cardiovascular moderado', 'seguimiento respiratorio estacional', 'control sano pendiente', 'riesgo social prioritario', 'seguimiento post alta hospitalaria', 'salud mental en seguimiento', 'polifarmacia', 'control infantil'],
    languages: ['espanol', 'espanol', 'espanol', 'creole', 'otro'],
    channels: ['telefono', 'telefono', 'sms', 'whatsapp', 'correo'],
    representativeNames: ['Ana', 'Pedro', 'Carolina', 'Miguel', 'Ruth', 'Paola', 'Claudio', 'Miriam', 'Soledad', 'Juan', 'Francisca', 'Ricardo'],
    closureNotes: ['Control vigente en APS', 'Requiere seguimiento territorial', 'Prioridad definida por equipo clinico', 'Caso revisado en comite local', 'Seguimiento compartido con gestor comunal']
  };
}

function summarize(db) {
  return {
    patients: db.patients.length,
    appointments: db.appointments.length,
    waitlist: db.waitlist.length,
    contact_cases: db.contact_cases.length,
    contact_messages: db.contact_messages.length,
    sidra: db.sidra.length,
    monthly_reports: (db.monthly_reports || []).length,
    audit: db.audit.length
  };
}

function createLargeDataset(base) {
  const db = clone(base);
  const rand = mulberry32(310032);
  const {
    firstNames,
    lastNames,
    sectors,
    risks,
    languages,
    channels,
    representativeNames,
    closureNotes
  } = createPatientGenerators();

  const corePatients = clone(base.patients || []);
  const coreContacts = clone(base.patient_contacts || []);
  const corePreferences = clone(base.contact_preferences || []);
  const coreConsents = clone(base.consents || []);
  const coreRepresentatives = clone(base.representatives || []);
  const coreSlots = clone(base.slots || []);
  const coreAppointments = clone(base.appointments || []);
  const coreWaitlist = clone(base.waitlist || []);
  const coreWaitlistOffers = clone(base.waitlist_offers || []);
  const coreWaitlistEvents = clone(base.waitlist_events || []);
  const coreCases = clone(base.contact_cases || []);
  const coreMessages = clone(base.contact_messages || []);
  const coreSidra = clone(base.sidra || []);
  const coreSidraAttempts = clone(base.sidra_attempts || []);

  const establishments = ['cesfam-quilicura', 'cesfam-bauza', 'sapu-quilicura'];
  const agendasByEstablishment = {
    'cesfam-quilicura': { agenda_id: 'AG-001', professional_id: 'PR-001', service_id: 'SV-001', professional: 'Dra. Marina Silva', service: 'Medicina general' },
    'cesfam-bauza': { agenda_id: 'AG-003', professional_id: 'PR-003', service_id: 'SV-003', professional: 'Dra. Carolina Munoz', service: 'Medicina general Bauza' },
    'sapu-quilicura': { agenda_id: 'AG-002', professional_id: 'PR-002', service_id: 'SV-002', professional: 'Enf. Paula Soto', service: 'Control cardiovascular' }
  };

  const generatedPatients = [];
  const generatedContacts = [];
  const generatedPreferences = [];
  const generatedConsents = [];
  const generatedRepresentatives = [];
  const generatedSlots = [];
  const generatedAppointments = [];
  const generatedHistory = [];
  const generatedWaitlist = [];
  const generatedWaitlistOffers = [];
  const generatedWaitlistEvents = [];
  const generatedCases = [];
  const generatedMessages = [];
  const generatedSidra = [];
  const generatedSidraAttempts = [];
  const generatedReports = [];
  const generatedAudit = [];

  for (let index = 0; index < 108; index += 1) {
    const number = 2001 + index;
    const establishmentId = pick(establishments, index);
    const firstName = pick(firstNames, index);
    const middleName = pick(firstNames, index + 3);
    const lastName = pick(lastNames, index + 5);
    const maternalName = pick(lastNames, index + 9);
    const legalName = `${firstName} ${middleName} ${lastName} ${maternalName}`;
    const createdAt = new Date(Date.UTC(2026, 0, 3 + (index % 25), 8 + (index % 7), (index * 11) % 60, 0, 0)).toISOString();
    const birthYear = 1954 + (index % 45);
    const birthMonth = (index * 3) % 12;
    const birthDay = 1 + (index * 5) % 27;
    const patientId = `P-${number}`;
    const preferredChannel = pick(channels, index);
    const language = pick(languages, index);
    const contactable = index % 9 !== 0;
    const status = index % 19 === 0 ? 'pendiente_validacion' : index % 23 === 0 ? 'inactivo' : 'activo';
    const patient = {
      id: patientId,
      identifier_kind: index % 7 === 0 ? 'transient' : 'definitive',
      rut: index % 7 === 0 ? '' : formatRut(12000000 + index * 137 + (index % 9) * 17),
      transient_reason: index % 7 === 0 ? 'Paciente en regularizacion documental local' : null,
      legal_name: legalName,
      social_name: `${firstName} ${lastName}`,
      birth_date: `${birthYear}-${String(birthMonth + 1).padStart(2, '0')}-${String(birthDay).padStart(2, '0')}`,
      status,
      sector: pick(sectors, index),
      risk: pick(risks, index),
      contactable,
      establishment_id: establishmentId,
      notes: `${pick(closureNotes, index)}. Referente comunitario asignado: ${pick(representativeNames, index + 2)}.`,
      created_at: createdAt,
      updated_at: createdAt,
      created_by: 'system',
      updated_by: 'system'
    };
    generatedPatients.push(patient);

    const phone = `+569${String(30000000 + index).padStart(8, '0')}`;
    generatedContacts.push({
      id: `CNT-${pad(2001 + index)}`,
      patient_id: patientId,
      type: 'telefono',
      label: 'Principal',
      value: phone,
      secure_channel: true,
      verified_at: createdAt,
      notes: 'Contacto principal validado en admision local.',
      created_at: createdAt,
      updated_at: createdAt,
      created_by: 'system',
      updated_by: 'system'
    });

    if (index % 4 === 0) {
      generatedContacts.push({
        id: `CNT-${pad(2301 + index)}`,
        patient_id: patientId,
        type: 'correo',
        label: 'Correo',
        value: `paciente.${number}@quilicura.local`,
        secure_channel: false,
        verified_at: null,
        notes: 'Canal complementario declarado en ficha.',
        created_at: createdAt,
        updated_at: createdAt,
        created_by: 'system',
        updated_by: 'system'
      });
    }

    generatedPreferences.push({
      id: `CPF-${pad(2001 + index)}`,
      patient_id: patientId,
      preferred_channel: preferredChannel,
      preferred_language: language,
      avoid_channel: preferredChannel === 'correo' ? 'whatsapp' : null,
      updated_at: createdAt,
      updated_by: 'system'
    });

    generatedConsents.push({
      id: `CON-${pad(2001 + index)}`,
      patient_id: patientId,
      purpose: index % 3 === 0 ? 'recordatorio_cita' : 'contactabilidad_preventiva',
      channel: preferredChannel,
      status: index % 11 === 0 ? 'revocado' : 'vigente',
      granted_at: createdAt,
      revoked_at: index % 11 === 0 ? new Date(Date.parse(createdAt) + 86400000 * 30).toISOString() : null,
      updated_at: createdAt,
      updated_by: 'system'
    });

    if (index % 5 === 0) {
      generatedRepresentatives.push({
        id: `REP-${pad(2001 + index)}`,
        patient_id: patientId,
        name: `${pick(representativeNames, index)} ${lastName}`,
        relationship: index % 2 === 0 ? 'hija' : 'pareja',
        phone,
        notes: 'Persona de apoyo registrada por admision.',
        created_at: createdAt,
        updated_at: createdAt,
        created_by: 'system',
        updated_by: 'system'
      });
    }
  }

  const appointmentStatuses = ['confirmada', 'agendada', 'confirmada', 'reprogramacion_solicitada', 'cancelada', 'confirmada', 'agendada', 'reprogramada'];
  for (let index = 0; index < 174; index += 1) {
    const appointmentIndex = 601 + index;
    const patient = generatedPatients[index % generatedPatients.length];
    const agenda = agendasByEstablishment[patient.establishment_id] || agendasByEstablishment['cesfam-quilicura'];
    const startsAt = isoDate(10 + Math.floor(index / 6), 12 + (index % 5), (index % 2) * 30);
    const endsAt = new Date(Date.parse(startsAt) + 30 * 60 * 1000).toISOString();
    const status = pick(appointmentStatuses, index);
    const reserved = status !== 'cancelada';
    const slotId = `S-${100 + index}`;
    const slot = {
      id: slotId,
      agenda_id: agenda.agenda_id,
      professional_id: agenda.professional_id,
      service_id: agenda.service_id,
      professional: agenda.professional,
      service: agenda.service,
      establishment_id: patient.establishment_id,
      starts_at: startsAt,
      ends_at: endsAt,
      day: '',
      time: '',
      status: reserved ? 'reservado' : 'disponible',
      appointment_id: reserved ? `C-${appointmentIndex}` : null,
      block_reason: null
    };
    generatedSlots.push(slot);
    generatedAppointments.push({
      id: `C-${appointmentIndex}`,
      patientId: patient.id,
      slotId,
      agenda_id: agenda.agenda_id,
      professional_id: agenda.professional_id,
      service_id: agenda.service_id,
      establishment_id: patient.establishment_id,
      status,
      confirmation_status: status === 'cancelada' ? 'sin_confirmar' : status === 'confirmada' ? 'confirmada' : 'pendiente',
      channel: pick(['telefono', 'meson', 'whatsapp'], index),
      note: `Cita semilla v0031 #${appointmentIndex}`,
      origin: 'seed_v0031',
      starts_at: startsAt,
      created_at: new Date(Date.parse(startsAt) - 12 * 86400000).toISOString(),
      updated_at: new Date(Date.parse(startsAt) - 8 * 86400000).toISOString(),
      created_by: 'system',
      updated_by: 'system'
    });
    generatedHistory.push({
      id: `AH-${pad(2001 + index)}`,
      appointment_id: `C-${appointmentIndex}`,
      action: status === 'cancelada' ? 'appointment.cancelled' : status === 'reprogramada' ? 'appointment.rescheduled' : 'appointment.created',
      actor: 'system',
      at: new Date(Date.parse(startsAt) - 7 * 86400000).toISOString(),
      detail: `Historial generado para cita ${appointmentIndex}.`
    });
  }

  for (let index = 0; index < 36; index += 1) {
    const patient = generatedPatients[(index * 3) % generatedPatients.length];
    const agenda = agendasByEstablishment[patient.establishment_id] || agendasByEstablishment['cesfam-quilicura'];
    const startsAt = isoDate(45 + Math.floor(index / 4), 9 + (index % 6), (index % 2) * 30);
    const endsAt = new Date(Date.parse(startsAt) + 30 * 60 * 1000).toISOString();
    generatedSlots.push({
      id: `S-${400 + index}`,
      agenda_id: agenda.agenda_id,
      professional_id: agenda.professional_id,
      service_id: agenda.service_id,
      professional: agenda.professional,
      service: agenda.service,
      establishment_id: patient.establishment_id,
      starts_at: startsAt,
      ends_at: endsAt,
      day: '',
      time: '',
      status: index % 9 === 0 ? 'bloqueado' : 'disponible',
      appointment_id: null,
      block_reason: index % 9 === 0 ? 'Bloqueo operativo semilla v0031.' : null
    });
  }

  const waitlistStatuses = ['activa', 'oferta_activa', 'resuelta', 'cerrada'];
  for (let index = 0; index < 46; index += 1) {
    const patient = generatedPatients[(index * 2) % generatedPatients.length];
    const agenda = agendasByEstablishment[patient.establishment_id] || agendasByEstablishment['cesfam-quilicura'];
    const waitlistId = `LE-${800 + index}`;
    const requestedAt = isoDate(index, 8 + (index % 5), 0);
    const status = pick(waitlistStatuses, index);
    const offerId = status === 'oferta_activa' ? `WO-${900 + index}` : null;
    generatedWaitlist.push({
      id: waitlistId,
      patientId: patient.id,
      service_id: agenda.service_id,
      service: agenda.service,
      status,
      priority_rule: 'RL-01',
      priority_reason: patient.risk,
      requested_at: requestedAt,
      created_at: requestedAt,
      created_by: 'system',
      updated_at: requestedAt,
      updated_by: 'system',
      active_offer_id: offerId,
      closed_reason: status === 'cerrada' ? 'cierre_manual_local' : null,
      note: `Lista de espera operativa v0031 #${index + 1}.`,
      source: index % 3 === 0 ? 'sin_cupo_manual' : 'contact_center',
      establishment_id: patient.establishment_id
    });
    generatedWaitlistEvents.push({
      id: `WE-${pad(2001 + index)}`,
      waitlist_id: waitlistId,
      action: status === 'resuelta' ? 'waitlist.resolved' : 'waitlist.created',
      actor: 'system',
      at: requestedAt,
      detail: `Evento semilla para ${waitlistId}.`
    });
    if (offerId) {
      generatedWaitlistOffers.push({
        id: offerId,
        waitlist_id: waitlistId,
        slot_id: generatedSlots[(index * 4) % generatedSlots.length].id,
        patient_id: patient.id,
        status: index % 2 === 0 ? 'pendiente_respuesta' : 'expirada',
        expires_at: new Date(Date.parse(requestedAt) + 90 * 60 * 1000).toISOString(),
        offered_by: 'system',
        rule_applied: 'RL-01',
        created_at: requestedAt,
        updated_at: requestedAt
      });
    }
  }

  const caseStatuses = ['activa', 'respuesta_recibida', 'no_contactable', 'escalada', 'cerrada'];
  for (let index = 0; index < 72; index += 1) {
    const patient = generatedPatients[(index * 5) % generatedPatients.length];
    const channel = pick(channels, index);
    const caseId = `CC-${900 + index}`;
    const openedAt = isoDate(5 + index, 10 + (index % 4), 15);
    const status = pick(caseStatuses, index);
    generatedCases.push({
      id: caseId,
      patient_id: patient.id,
      establishment_id: patient.establishment_id,
      purpose: index % 2 === 0 ? 'recordatorio_cita' : 'contactabilidad_preventiva',
      channel,
      status,
      assigned_to: index % 3 === 0 ? 'gestor.cesfam' : 'admin.comunal',
      risk: patient.risk,
      opened_at: openedAt,
      updated_at: openedAt,
      updated_by: 'system',
      created_by: 'system',
      created_at: openedAt,
      close_reason: status === 'cerrada' ? 'manual_resolution' : status === 'no_contactable' ? 'no_contactable' : null
    });

    const attempts = status === 'no_contactable' ? 3 : 2;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const sentAt = new Date(Date.parse(openedAt) + attempt * 3600000).toISOString();
      generatedMessages.push({
        id: `MSG-${pad(3001 + index * 3 + attempt)}`,
        case_id: caseId,
        patient_id: patient.id,
        establishment_id: patient.establishment_id,
        channel,
        template_id: pick(['TPL-0001', 'TPL-0002', 'TPL-0004', 'TPL-0005'], index + attempt),
        status: attempt === attempts - 1 && status === 'respuesta_recibida' ? 'responded' : attempt === attempts - 1 && status === 'no_contactable' ? 'failed' : 'delivered',
        result: attempt === attempts - 1 && status === 'respuesta_recibida' ? 'success' : attempt === attempts - 1 && status === 'no_contactable' ? 'no_response' : 'success',
        sensitive_blocked: false,
        content_preview: `Mensaje local ${channel} para ${patient.social_name}.`,
        sent_at: sentAt,
        updated_at: sentAt,
        created_at: sentAt,
        created_by: 'system',
        updated_by: 'system'
      });
    }
  }

  const sidraStatuses = ['acknowledged', 'queued', 'retry_pending', 'discrepancy', 'failed'];
  for (let index = 0; index < 21; index += 1) {
    const appointment = generatedAppointments[index];
    const queuedAt = isoDate(20 + index, 7 + (index % 4), 0);
    const status = pick(sidraStatuses, index);
    const eventId = `EV-${9100 + index}`;
    generatedSidra.push({
      id: eventId,
      correlation_id: `seed-v0031-${index + 1}`,
      type: index % 2 === 0 ? 'appointment.created' : 'waitlist.updated',
      entity: index % 2 === 0 ? 'appointment' : 'waitlist',
      entity_id: index % 2 === 0 ? appointment.id : generatedWaitlist[index % generatedWaitlist.length].id,
      establishment_id: appointment.establishment_id,
      status,
      retries: status === 'retry_pending' ? 1 : status === 'failed' ? 3 : 0,
      max_retries: 3,
      payload: {
        seeded: true,
        sequence: index + 1
      },
      simulation_default_result: status === 'queued' ? 'acknowledged' : status,
      last_error: status === 'failed' ? 'Timeout local simulado' : null,
      last_error_code: status === 'failed' ? 'LOCAL_TIMEOUT' : null,
      discrepancy_note: status === 'discrepancy' ? 'Prestacion no coincide con cola local.' : null,
      queued_at: queuedAt,
      sent_at: status === 'queued' ? null : new Date(Date.parse(queuedAt) + 5 * 60000).toISOString(),
      acknowledged_at: status === 'acknowledged' ? new Date(Date.parse(queuedAt) + 9 * 60000).toISOString() : null,
      resolved_at: ['acknowledged', 'failed', 'discrepancy'].includes(status) ? new Date(Date.parse(queuedAt) + 10 * 60000).toISOString() : null,
      next_retry_at: status === 'retry_pending' ? new Date(Date.parse(queuedAt) + 15 * 60000).toISOString() : null,
      updated_at: queuedAt,
      updated_by: 'system'
    });
    generatedSidraAttempts.push({
      id: `SIA-${pad(2001 + index)}`,
      event_id: eventId,
      at: queuedAt,
      result: status === 'acknowledged' ? 'acknowledged' : status === 'discrepancy' ? 'discrepancy' : status === 'failed' ? 'failed' : 'retry_pending',
      detail: `Intento local semilla ${index + 1}.`
    });
  }

  for (let month = 0; month < 4; month += 1) {
    const period = `2026-${String(month + 4).padStart(2, '0')}`;
    generatedReports.push({
      id: `RPT-${pad(3001 + month)}`,
      period,
      establishment_id: month % 2 === 0 ? 'cesfam-quilicura' : 'cesfam-bauza',
      channel: month % 2 === 0 ? 'telefono' : 'whatsapp',
      totals: {
        appointments: 28 + month * 3,
        attended: 20 + month * 2,
        no_show: 3 + month,
        waitlist_active: 11 + month,
        contact_cases: 15 + month * 2
      },
      generated_at: new Date(Date.UTC(2026, month + 3, 28, 18, 30, 0, 0)).toISOString(),
      generated_by: 'system',
      purpose: 'seguimiento_local'
    });
  }

  for (let index = 0; index < 80; index += 1) {
    const actor = index % 4 === 0 ? 'admin.comunal' : index % 4 === 1 ? 'gestor.cesfam' : index % 4 === 2 ? 'profesional.demo' : 'system';
    generatedAudit.push({
      at: new Date(Date.UTC(2026, 5, 1 + (index % 27), 9 + (index % 7), (index * 7) % 60, 0, 0)).toISOString(),
      actor,
      role: actor === 'gestor.cesfam' ? 'gestor_cesfam' : actor === 'profesional.demo' ? 'profesional' : actor === 'admin.comunal' ? 'administrador_comunal' : 'system',
      action: index % 5 === 0 ? 'patients.update' : index % 5 === 1 ? 'auth.login.success' : index % 5 === 2 ? 'agenda.create' : index % 5 === 3 ? 'waitlist.offer' : 'contact.message.sent',
      entity: index % 2 === 0 ? 'patient' : 'session',
      result: 'pass',
      detail: `Auditoria semilla v0031 #${index + 1}.`,
      origin: 'seed_generator'
    });
  }

  db.phase = 'v0031 - Autenticacion local y seed operativo';
  db.sessions = [];
  db.patients = [...corePatients, ...generatedPatients];
  db.representatives = [...coreRepresentatives, ...generatedRepresentatives];
  db.patient_contacts = [...coreContacts, ...generatedContacts];
  db.contact_preferences = [...corePreferences, ...generatedPreferences];
  db.consents = [...coreConsents, ...generatedConsents];
  db.slots = [...coreSlots, ...generatedSlots];
  db.appointments = [...coreAppointments, ...generatedAppointments];
  db.appointment_history = [...(base.appointment_history || []), ...generatedHistory];
  db.waitlist = [...coreWaitlist, ...generatedWaitlist];
  db.waitlist_offers = [...coreWaitlistOffers, ...generatedWaitlistOffers];
  db.waitlist_events = [...coreWaitlistEvents, ...generatedWaitlistEvents];
  db.contact_cases = [...coreCases, ...generatedCases];
  db.contact_messages = [...coreMessages, ...generatedMessages];
  db.sidra = [...coreSidra, ...generatedSidra];
  db.sidra_attempts = [...coreSidraAttempts, ...generatedSidraAttempts];
  db.monthly_reports = generatedReports;
  db.audit = [...generatedAudit, ...(base.audit || [])].slice(0, 220);

  return db;
}

async function writeJson(targetPath, value) {
  await writeFile(resolve(targetPath), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeDatabase(targetPath, value) {
  if (String(targetPath).endsWith('.json')) {
    await writeJson(targetPath, value);
    return;
  }
  await createSqliteDatabase(resolve(targetPath), value, {
    source: resolve(options.input)
  });
}

async function readRuntimeMetadata() {
  try {
    return JSON.parse(await readFile(resolve('config/operational.json'), 'utf8'));
  } catch {
    return null;
  }
}

const options = parseArgs(process.argv.slice(2));
const base = JSON.parse(await readFile(resolve(options.input), 'utf8'));
const dataset = createLargeDataset(base);
const runtimeMetadata = await readRuntimeMetadata();

if (runtimeMetadata?.version) {
  dataset.version = runtimeMetadata.version;
}
if (runtimeMetadata?.phase) {
  dataset.phase = runtimeMetadata.phase;
}
if (runtimeMetadata?.sidra_mode) {
  dataset.sidra_mode = runtimeMetadata.sidra_mode;
}
dataset.production_data = false;

await writeJson(options.seedOutput, dataset);
await writeDatabase(options.dbOutput, { ...dataset, sessions: [] });

if (options.summary) {
  console.log(JSON.stringify(summarize(dataset), null, 2));
}
