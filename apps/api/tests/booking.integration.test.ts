import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { createPrisma } from '../src/infrastructure/prisma.js';
import { BookingService } from '../src/modules/booking/service.js';
import {
  BookingError,
  databaseErrorFacts,
  translateDatabaseError,
} from '../src/modules/booking/errors.js';
import { withTransaction } from '../src/modules/booking/transaction.js';
import {
  seedSyntheticClinic,
  syntheticContacts,
  syntheticIds as ids,
} from '../src/testing/synthetic-clinic.js';

const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !/^\/clinic_test_[a-f0-9]{32}$/.test(new URL(url).pathname) ||
  url !== process.env.DATABASE_URL
) {
  throw new Error('These tests require the owned disposable database runner');
}
const client = createPrisma(url);
const secondClient = createPrisma(url);
const sql = new pg.Pool({ connectionString: url, max: 25 });
const secret = randomBytes(32);
const now = new Date('2030-01-01T00:00:00Z');
let clock = new Date(now);
const engine = new BookingService(client, { idempotencySecret: secret, now: () => clock });
const secondEngine = new BookingService(secondClient, {
  idempotencySecret: secret,
  now: () => clock,
});

function request(startsAt = '2030-01-02T04:00:00Z') {
  return {
    doctorId: ids.doctors[0],
    serviceId: ids.services[0],
    startsAt,
    expectedPriceKzt: '9000.00',
    expectedDurationMinutes: 30,
    idempotencyKey: randomBytes(16).toString('hex'),
    contacts: syntheticContacts(secret),
    consent: { documentId: ids.consent, accepted: true, locale: 'ru' },
  };
}
const workingWindow = {
  doctorId: ids.doctors[0],
  startsAt: '2030-01-02T04:00:00Z',
  endsAt: '2030-01-02T07:00:00Z',
};

beforeEach(async () => {
  clock = new Date(now);
  // Static table names; URL was checked above. Never run against the application DB.
  await client.$executeRaw`TRUNCATE TABLE bootstrap_state, rate_limit_buckets, audit_events, idempotency_keys, appointment_consents,
    appointments, availability_windows, doctor_services, doctors, services, staff_sessions,
    staff_users, consent_documents`;
  await seedSyntheticClinic(client, new Date('2030-01-02T00:00:00Z'), now);
});
afterAll(async () => {
  await Promise.all([client.$disconnect(), secondClient.$disconnect(), sql.end()]);
});

async function rawInsert(
  startsAt: string,
  doctorId: string = ids.doctors[0],
  duration = 30,
  withConsent = true,
) {
  const connection = await sql.connect();
  const id = randomUUID();
  const contacts = syntheticContacts(secret);
  try {
    await connection.query('BEGIN');
    await connection.query(
      `INSERT INTO appointments (
      id, reference, doctor_id, service_id, starts_at, ends_at, duration_minutes_snapshot,
      price_kzt_snapshot, patient_name_ciphertext, phone_ciphertext, encryption_key_version, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,9000,$8,$9,$10,now())`,
      [
        id,
        randomUUID(),
        doctorId,
        ids.services[0],
        new Date(startsAt),
        new Date(new Date(startsAt).getTime() + duration * 60000),
        duration,
        Buffer.from(contacts.patientNameCiphertext),
        Buffer.from(contacts.phoneCiphertext),
        contacts.encryptionKeyVersion,
      ],
    );
    if (withConsent)
      await connection.query(
        `INSERT INTO appointment_consents (appointment_id,document_id,accepted_at,locale) VALUES ($1,$2,$3,'ru')`,
        [id, ids.consent, now],
      );
    await connection.query('COMMIT');
    return id;
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

describe('migration invariants, inspected directly in PostgreSQL', () => {
  it('contains all 13 tables, manual constraints, FK indexes and deferred consent trigger after repeat deploy', async () => {
    const tables = await sql.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'",
    );
    expect(tables.rowCount).toBe(13);
    const constraints = await sql.query<{ conname: string; contype: string }>(
      `SELECT conname,contype FROM pg_constraint WHERE conname IN ('appointments_no_overlap','availability_no_overlap','appointment_contacts','appointment_valid_interval','services_valid_offer','bootstrap_singleton','rate_limit_valid')`,
    );
    expect(constraints.rows.filter((row) => row.contype === 'x')).toHaveLength(2);
    expect(constraints.rowCount).toBe(7);
    const securityTriggers = await sql.query(
      "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('staff_security_revokes_sessions','bootstrap_marker_immutable')",
    );
    expect(securityTriggers.rowCount).toBe(2);
    const trigger = await sql.query<{ tgdeferrable: boolean; tginitdeferred: boolean }>(
      "SELECT tgdeferrable,tginitdeferred FROM pg_trigger WHERE tgname='appointment_requires_consent'",
    );
    expect(trigger.rows).toEqual([{ tgdeferrable: true, tginitdeferred: true }]);
    const index = await sql.query(
      "SELECT 1 FROM pg_indexes WHERE indexname='appointments_doctor_id_service_id_idx'",
    );
    expect(index.rowCount).toBe(1);
    const missingFkIndexes = await sql.query<{ conname: string }>(`
      SELECT c.conname FROM pg_constraint c
      WHERE c.contype='f' AND c.connamespace='public'::regnamespace
      AND NOT EXISTS (
        SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid
        AND (SELECT array_agg(k ORDER BY ord) FROM unnest(i.indkey::smallint[]) WITH ORDINALITY keys(k,ord)
          WHERE ord <= cardinality(c.conkey)) = c.conkey
      )`);
    expect(missingFkIndexes.rows).toEqual([]);
    expect(
      await client.staffUser.findUnique({
        where: { id: ids.staff },
        select: { isActive: true, mfaEnabled: true },
      }),
    ).toEqual({ isActive: false, mfaEnabled: false });
  });

  it('raw concurrent SQL: 20 attempts yield one commit and 19 SQLSTATE 23P01 errors', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => rawInsert('2030-01-02T04:00:00Z')),
    );
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((row) => row.status === 'rejected');
    expect(rejected).toHaveLength(19);
    for (const row of rejected) {
      expect(databaseErrorFacts(row.reason).codes.has('23P01')).toBe(true);
      expect(databaseErrorFacts(row.reason).constraints.has('appointments_no_overlap')).toBe(true);
    }
    expect(await client.appointment.count()).toBe(1);
    expect(await client.appointmentConsent.count()).toBe(1);
    console.log('Raw PostgreSQL concurrency: 1 committed, 19 exclusion conflicts (23P01).');
  });

  it('allows adjacent intervals and independent doctors; rejects partial overlaps of different lengths', async () => {
    await rawInsert('2030-01-02T04:00:00Z', ids.doctors[0], 45);
    await expect(rawInsert('2030-01-02T04:30:00Z')).rejects.toMatchObject({ code: '23P01' });
    await rawInsert('2030-01-02T04:45:00Z');
    await rawInsert('2030-01-02T04:00:00Z', ids.doctors[1]);
    expect(await client.appointment.count()).toBe(3);
  });

  it('refuses orphan appointment commits and preserves FK references', async () => {
    await expect(
      rawInsert('2030-01-02T04:00:00Z', ids.doctors[0], 30, false),
    ).rejects.toMatchObject({ code: '23514', constraint: 'appointment_requires_consent' });
    expect(await client.appointment.count()).toBe(0);
    await expect(client.doctor.delete({ where: { id: ids.doctors[0] } })).rejects.toMatchObject({
      code: 'P2003',
    });
    expect(await client.doctor.count()).toBe(2);
  });

  it('enforces offer, contacts, MFA/email and immutable consent/audit constraints in SQL', async () => {
    await expect(
      sql.query('INSERT INTO bootstrap_state (id,admin_user_id) VALUES (false,$1)', [ids.staff]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'bootstrap_singleton' });
    await expect(
      sql.query(
        'INSERT INTO rate_limit_buckets (key_hash,attempts,resets_at) VALUES ($1,0,now())',
        ['a'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'rate_limit_valid' });
    await expect(
      sql.query(
        "INSERT INTO rate_limit_buckets (key_hash,attempts,resets_at) VALUES ($1,1,'infinity')",
        ['a'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'rate_limit_valid' });
    await expect(
      sql.query('UPDATE services SET duration_minutes=0 WHERE id=$1', [ids.services[0]]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql.query('UPDATE services SET price_kzt=-1 WHERE id=$1', [ids.services[0]]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql.query("UPDATE services SET price_kzt='NaN' WHERE id=$1", [ids.services[0]]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql.query('UPDATE staff_users SET email=$1 WHERE id=$2', [
        'UPPER@example.invalid',
        ids.staff,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql.query('UPDATE staff_users SET mfa_enabled=true WHERE id=$1', [ids.staff]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql.query("UPDATE consent_documents SET text_ru='changed' WHERE id=$1", [ids.consent]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'consent_document_immutable' });
    const created = await engine.create(request());
    await expect(
      sql.query('UPDATE appointments SET phone_ciphertext=NULL WHERE id=$1', [created.id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'appointment_contacts' });
    await expect(
      sql.query("UPDATE appointments SET ends_at=ends_at+interval '1 minute' WHERE id=$1", [
        created.id,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'appointment_valid_interval' });
    await expect(
      sql.query("UPDATE appointment_consents SET locale='kk' WHERE appointment_id=$1", [
        created.id,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'consent_evidence_immutable' });
    await expect(
      sql.query('DELETE FROM appointment_consents WHERE appointment_id=$1', [created.id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'appointment_requires_consent' });
    await engine.transition({ appointmentId: created.id, version: 1, status: 'CONFIRMED' });
    await expect(sql.query('DELETE FROM audit_events')).rejects.toMatchObject({
      code: '23514',
      constraint: 'audit_append_only',
    });
  });

  it('maps the actual Prisma adapter exclusion and unique errors without masking other failures', async () => {
    const row = await client.appointment.findUnique({
      where: { id: (await engine.create(request())).id },
    });
    if (!row) throw new Error('Fixture missing');
    try {
      await client.appointment.create({
        data: { ...row, id: randomUUID(), reference: randomUUID() },
      });
      expect.unreachable();
    } catch (error) {
      expect(databaseErrorFacts(error).codes.has('23P01')).toBe(true);
      expect(translateDatabaseError(error)).toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    }
    try {
      await client.staffUser.create({
        data: { email: 'synthetic-admin@example.invalid', passwordHash: 'DISABLED', role: 'ADMIN' },
      });
      expect.unreachable();
    } catch (error) {
      expect(translateDatabaseError(error)).toMatchObject({ code: 'DUPLICATE_RESOURCE' });
    }
    const unrelated = new Error('unrelated');
    expect(translateDatabaseError(unrelated)).toBe(unrelated);
  });
});

describe('internal transactional booking service, no HTTP endpoints', () => {
  it('20 parallel requests across two Prisma pools produce exactly one booking', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? engine : secondEngine).create(request())),
    );
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    for (const row of results)
      if (row.status === 'rejected') expect(row.reason).toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(await client.appointment.count()).toBe(1);
    expect(await client.appointmentConsent.count()).toBe(1);
    expect(await client.idempotencyKey.count()).toBe(1);
    console.log(
      'Prisma service concurrency: 1 booking, 19 SLOT_UNAVAILABLE; two independent pools.',
    );
  });

  it('serializes same-key requests; re-sealing and equivalent timezone offsets replay safely', async () => {
    const command = request();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? engine : secondEngine).create({ ...command, contacts: syntheticContacts(secret) }),
      ),
    );
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    expect(results.filter((row) => !row.replayed)).toHaveLength(1);
    expect(await client.idempotencyKey.count()).toBe(1);
    const replay = await engine.create({
      ...command,
      startsAt: '2030-01-02T09:00:00+05:00',
      contacts: syntheticContacts(secret),
    });
    expect(replay.replayed).toBe(true);
    await expect(
      engine.create({ ...command, startsAt: '2030-01-02T05:00:00Z' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      engine.create({
        ...command,
        contacts: syntheticContacts(secret, 'different-synthetic-visitor'),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('replays before checking current active status, but refuses expired keys', async () => {
    const command = request();
    const first = await engine.create(command);
    await engine.setDoctorActive(command.doctorId, false);
    expect((await engine.create(command)).id).toBe(first.id);
    clock = new Date(now.getTime() + 24 * 60 * 60000);
    await expect(engine.create(command)).rejects.toMatchObject({ code: 'IDEMPOTENCY_EXPIRED' });
  });

  it.each(['2030-01-02T03:45:00Z', '2030-01-02T06:45:00Z', '2030-01-02T07:30:00Z'])(
    'rejects outside work or across a break: %s',
    async (startsAt) => {
      await expect(engine.create(request(startsAt))).rejects.toMatchObject({
        code: 'OUTSIDE_WORKING_HOURS',
      });
    },
  );

  it('uses duration and window-anchored steps when listing slots', async () => {
    const result = await engine.availability({
      doctorId: ids.doctors[0],
      serviceId: ids.services[2],
      from: '2030-01-02T04:00:00Z',
      to: '2030-01-02T08:00:00Z',
    });
    expect(result.durationMinutes).toBe(25);
    expect(result.slots.at(-1)).toEqual({
      startsAt: '2030-01-02T06:30:00.000Z',
      endsAt: '2030-01-02T06:55:00.000Z',
    });
    await engine.create(request());
    const busy = await engine.availability({
      doctorId: ids.doctors[0],
      serviceId: ids.services[0],
      from: '2030-01-02T04:00:00Z',
      to: '2030-01-02T05:00:00Z',
    });
    expect(busy.slots.map((slot) => slot.startsAt)).toEqual(['2030-01-02T04:30:00.000Z']);
    await expect(engine.create(request('2030-01-02T04:07:00Z'))).rejects.toMatchObject({
      code: 'INVALID_SLOT_START',
    });
    await expect(engine.create(request('2029-12-31T04:00:00Z'))).rejects.toMatchObject({
      code: 'OUTSIDE_BOOKING_HORIZON',
    });
    await expect(engine.create(request('2031-01-02T04:00:00Z'))).rejects.toMatchObject({
      code: 'OUTSIDE_BOOKING_HORIZON',
    });
  });

  it('checks active assignment, consent, unknown fields and offer changes', async () => {
    await expect(engine.create({ ...request(), iin: 'SYNTHETIC_FORBIDDEN' })).rejects.toMatchObject(
      { code: 'INVALID_INPUT' },
    );
    await expect(
      engine.create({
        ...request(),
        consent: { documentId: ids.consent, accepted: false, locale: 'ru' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await engine.changeService({ serviceId: ids.services[0], priceKzt: '9500.00' });
    await expect(engine.create(request())).rejects.toMatchObject({ code: 'OFFER_CHANGED' });
    await engine.setAssignmentActive(ids.doctors[0], ids.services[0], false);
    await expect(engine.create(request())).rejects.toMatchObject({ code: 'INACTIVE_SELECTION' });
    expect(await client.appointment.count()).toBe(0);
  });

  it('rolls back the booking and its consent when the final idempotency write fails', async () => {
    await sql.query(`CREATE FUNCTION test_reject_key() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic failure' USING ERRCODE='23514'; END $$;
      CREATE TRIGGER test_reject_key BEFORE INSERT ON idempotency_keys FOR EACH ROW EXECUTE FUNCTION test_reject_key();`);
    try {
      await expect(engine.create(request())).rejects.toBeDefined();
      expect(await client.appointment.count()).toBe(0);
      expect(await client.appointmentConsent.count()).toBe(0);
      expect(await client.idempotencyKey.count()).toBe(0);
    } finally {
      await sql.query(
        'DROP TRIGGER test_reject_key ON idempotency_keys; DROP FUNCTION test_reject_key()',
      );
    }
  });

  it('refuses retired or not-yet-published consent without persisting a booking', async () => {
    await client.consentDocument.update({ where: { id: ids.consent }, data: { retiredAt: clock } });
    await expect(engine.create(request())).rejects.toMatchObject({ code: 'CONSENT_CHANGED' });
    const current = await client.consentDocument.findUniqueOrThrow({ where: { id: ids.consent } });
    const future = await client.consentDocument.create({
      data: {
        ...current,
        id: randomUUID(),
        version: 'synthetic-future',
        retiredAt: null,
        publishedAt: new Date(clock.getTime() + 60000),
      },
    });
    const command = request();
    await expect(
      engine.create({ ...command, consent: { ...command.consent, documentId: future.id } }),
    ).rejects.toMatchObject({ code: 'CONSENT_CHANGED' });
    expect(await client.appointment.count()).toBe(0);
    expect(await client.appointmentConsent.count()).toBe(0);
    expect(await client.idempotencyKey.count()).toBe(0);
  });

  it('inactive doctors and services reject new bookings without deleting existing ones', async () => {
    await engine.create(request());
    await engine.changeService({ serviceId: ids.services[0], isActive: false });
    await expect(engine.create(request('2030-01-02T05:00:00Z'))).rejects.toMatchObject({
      code: 'INACTIVE_SELECTION',
    });
    await engine.changeService({ serviceId: ids.services[0], isActive: true });
    await engine.setDoctorActive(ids.doctors[0], false);
    await expect(engine.create(request('2030-01-02T05:00:00Z'))).rejects.toMatchObject({
      code: 'INACTIVE_SELECTION',
    });
    expect(await client.appointment.count()).toBe(1);
  });

  it('completed history remains non-overlapping and cannot be reopened', async () => {
    const booking = await engine.create(request());
    await engine.transition({ appointmentId: booking.id, version: 1, status: 'CONFIRMED' });
    clock = new Date('2030-01-03T00:00:00Z');
    await engine.transition({ appointmentId: booking.id, version: 2, status: 'COMPLETED' });
    await expect(rawInsert(booking.startsAt)).rejects.toMatchObject({ code: '23P01' });
    await expect(
      engine.transition({ appointmentId: booking.id, version: 3, status: 'CANCELLED' }),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });
  });

  it('concurrent status changes with the same version produce one winner', async () => {
    const booking = await engine.create(request());
    const results = await Promise.allSettled([
      engine.transition({ appointmentId: booking.id, version: 1, status: 'CONFIRMED' }),
      secondEngine.transition({ appointmentId: booking.id, version: 1, status: 'CANCELLED' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results)
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('cancellation frees a slot, version conflicts do not overwrite state, and snapshots persist', async () => {
    const created = await engine.create(request());
    await engine.changeService({
      serviceId: ids.services[0],
      priceKzt: '12345.67',
      durationMinutes: 45,
    });
    const existing = await client.appointment.findUniqueOrThrow({ where: { id: created.id } });
    expect(existing.priceKztSnapshot.toFixed(2)).toBe('9000.00');
    expect(existing.durationMinutesSnapshot).toBe(30);
    const confirmed = await engine.transition({
      appointmentId: created.id,
      version: 1,
      status: 'CONFIRMED',
    });
    await expect(
      engine.transition({ appointmentId: created.id, version: 1, status: 'CANCELLED' }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(
      engine.transition({ appointmentId: created.id, version: 2, status: 'COMPLETED' }),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });
    await engine.transition({
      appointmentId: created.id,
      version: confirmed.version,
      status: 'CANCELLED',
    });
    const replacement = await engine.create({
      ...request(),
      expectedPriceKzt: '12345.67',
      expectedDurationMinutes: 45,
    });
    expect(replacement.endsAt).toBe('2030-01-02T04:45:00.000Z');
    await expect(
      engine.transition({ appointmentId: created.id, version: 3, status: 'CONFIRMED' }),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });
  });

  it('failed transfer leaves the original booking intact; successful transfer is atomic', async () => {
    const original = await engine.create(request());
    await engine.create({ ...request(), doctorId: ids.doctors[1] });
    const move = {
      appointmentId: original.id,
      version: 1,
      doctorId: ids.doctors[1],
      serviceId: ids.services[0],
      startsAt: original.startsAt,
      expectedPriceKzt: '9000.00',
      expectedDurationMinutes: 30,
    };
    await expect(engine.reschedule(move)).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(
      await client.appointment.findUnique({
        where: { id: original.id },
        select: { doctorId: true, version: true },
      }),
    ).toEqual({ doctorId: ids.doctors[0], version: 1 });
    const moved = await engine.reschedule({ ...move, startsAt: '2030-01-02T05:00:00Z' });
    expect(moved).toMatchObject({ doctorId: ids.doctors[1], version: 2, status: 'PENDING' });
    expect(await client.appointmentConsent.count()).toBe(2);
  });

  it('opposite cross-doctor transfers follow the same lock order', async () => {
    const a = await engine.create(request());
    const b = await engine.create({ ...request(), doctorId: ids.doctors[1] });
    const moves = [a, b].map((row, i) => ({
      appointmentId: row.id,
      version: 1,
      doctorId: ids.doctors[i === 0 ? 1 : 0],
      serviceId: ids.services[0],
      startsAt: '2030-01-02T05:00:00Z',
      expectedPriceKzt: '9000.00',
      expectedDurationMinutes: 30,
    }));
    const [first, second] = await Promise.all([
      engine.reschedule(moves[0]),
      secondEngine.reschedule(moves[1]),
    ]);
    expect(first.doctorId).toBe(ids.doctors[1]);
    expect(second.doctorId).toBe(ids.doctors[0]);
  });

  it('schedule mutation racing a booking never leaves an uncovered appointment', async () => {
    const results = await Promise.allSettled([
      engine.create(request('2030-01-02T05:30:00Z')),
      secondEngine.replaceWindow(ids.windows[0], {
        ...workingWindow,
        endsAt: '2030-01-02T05:00:00Z',
      }),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    const windows = await client.availabilityWindow.findMany({
      where: { doctorId: ids.doctors[0] },
    });
    const appointments = await client.appointment.findMany();
    expect(
      appointments.every((row) =>
        windows.some((window) => window.startsAt <= row.startsAt && window.endsAt >= row.endsAt),
      ),
    ).toBe(true);
    for (const row of results)
      if (row.status === 'rejected')
        expect(['SCHEDULE_HAS_APPOINTMENTS', 'OUTSIDE_WORKING_HOURS']).toContain(
          (row.reason as BookingError).code,
        );
  });

  it('refuses deletion of occupied work and overlapping windows', async () => {
    await engine.create(request());
    await expect(engine.deleteWindow(ids.windows[0])).rejects.toMatchObject({
      code: 'SCHEDULE_HAS_APPOINTMENTS',
    });
    await expect(
      engine.createWindow({
        ...workingWindow,
        startsAt: '2030-01-02T06:00:00Z',
        endsAt: '2030-01-02T09:00:00Z',
      }),
    ).rejects.toMatchObject({ code: 'SCHEDULE_OVERLAP' });
    await expect(
      engine.createWindow({
        ...workingWindow,
        startsAt: '2030-01-02T07:30:00Z',
        endsAt: '2030-01-02T07:00:00Z',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_WORKING_INTERVAL' });
  });

  it('retries a real SQLSTATE 40001 at most three times, but does not retry unrelated failures', async () => {
    let attempts = 0;
    await expect(
      withTransaction(client, async (tx) => {
        attempts++;
        await tx.$executeRaw`DO $$ BEGIN RAISE EXCEPTION 'Synthetic serialization' USING ERRCODE='40001'; END $$`;
      }),
    ).rejects.toMatchObject({ code: 'CONCURRENCY_RETRY_EXHAUSTED' });
    expect(attempts).toBe(3);
    let otherAttempts = 0;
    await expect(
      withTransaction(client, async () => {
        otherAttempts++;
        throw new BookingError('SYNTHETIC_FAILURE');
      }),
    ).rejects.toMatchObject({ code: 'SYNTHETIC_FAILURE' });
    expect(otherAttempts).toBe(1);
  });

  it('recovers from an actual PostgreSQL deadlock with a bounded transaction retry', async () => {
    const attempts = [0, 0];
    let arrived = 0;
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function worker(index: number, first: string, second: string) {
      return withTransaction(index === 0 ? client : secondClient, async (tx) => {
        attempts[index] = (attempts[index] ?? 0) + 1;
        await tx.$queryRaw`SELECT id FROM doctors WHERE id=${first}::uuid FOR UPDATE`;
        if (attempts[index] === 1) {
          if (++arrived === 2) release();
          await barrier;
        }
        await tx.$queryRaw`SELECT id FROM doctors WHERE id=${second}::uuid FOR UPDATE`;
        return true;
      });
    }
    // Intentionally reverse the order ONLY in this fault-injection test, never in BookingService.
    expect(
      await Promise.all([
        worker(0, ids.doctors[0], ids.doctors[1]),
        worker(1, ids.doctors[1], ids.doctors[0]),
      ]),
    ).toEqual([true, true]);
    expect(attempts.sort()).toEqual([1, 2]);
  });
});
