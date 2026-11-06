import { ledgerKey } from './ledger-keys.mjs';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { database, encryptFile, decryptFile, atomicJson, readFile, log } from './lib.mjs';
import { ledgerSnapshot, registerIntent, withRegistryLock } from './ledger.mjs';

export async function readPolicy() {
  if (!process.env.RETENTION_POLICY_FILE) return { approved: false };
  const p = JSON.parse(await readFile(process.env.RETENTION_POLICY_FILE, 'utf8'));
  if (typeof p.approved !== 'boolean' || (p.approved && typeof p.decisionReference !== 'string'))
    throw new Error('INVALID_RETENTION_POLICY');
  for (const name of [
    'backupRetentionDays',
    'technicalGraceSeconds',
    'appointmentRetentionDays',
    'unclaimedReceiptRetentionMinutes',
  ])
    if (p[name] != null && (!Number.isInteger(p[name]) || p[name] < 1 || p[name] > 31536000))
      throw new Error('INVALID_RETENTION_POLICY');
  return p;
}
export async function checkIntegrity(db) {
  const r =
    await db.query(`SELECT current_setting('server_version') AS version,current_database() AS database,
   (SELECT count(*)::int FROM appointments) AS appointments,
   (SELECT count(*)::int FROM appointment_consents) AS consents,
   (SELECT count(*)::int FROM pg_constraint WHERE conname IN ('appointments_no_overlap','availability_no_overlap')) AS exclusions,
   (SELECT count(*)::int FROM appointments a JOIN appointments b ON a.id<b.id AND a.doctor_id=b.doctor_id AND a.status<>'CANCELLED' AND b.status<>'CANCELLED' AND tstzrange(a.starts_at,a.ends_at,'[)') && tstzrange(b.starts_at,b.ends_at,'[)')) AS overlaps`);
  const row = r.rows[0];
  if (
    !/^18\.6(?:\s|$)/.test(row.version) ||
    row.exclusions !== 2 ||
    row.appointments !== row.consents ||
    row.overlaps !== 0
  )
    throw new Error('INTEGRITY_CHECK_FAILED');
  return row;
}
async function erase(db, id, operationId, reason) {
  const client = await db.connect();
  await client.query('BEGIN');
  try {
    const initial = (
      await client.query('SELECT doctor_id,service_id FROM appointments WHERE id=$1', [id])
    ).rows[0];
    if (!initial) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query('SELECT id FROM doctors WHERE id=$1 FOR UPDATE', [initial.doctor_id]);
    await client.query('SELECT id FROM services WHERE id=$1 FOR UPDATE', [initial.service_id]);
    const row = (
      await client.query(
        'SELECT id,doctor_id,service_id,patient_name_ciphertext FROM appointments WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (row.doctor_id !== initial.doctor_id || row.service_id !== initial.service_id)
      throw new Error('CONCURRENT_CHANGE_RETRY');
    if (row.patient_name_ciphertext === null) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query('DELETE FROM patient_consent_receipts WHERE appointment_id=$1', [id]);
    await client.query(
      'UPDATE appointments SET patient_name_ciphertext=NULL,phone_ciphertext=NULL,encryption_key_version=NULL,anonymized_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1 WHERE id=$1',
      [id],
    );
    await client.query(
      "INSERT INTO audit_events(id,action,entity_type,entity_id,request_id,metadata) VALUES($1,$2,'appointment',$3,$4,$5::jsonb)",
      [randomUUID(), 'APPOINTMENT_ANONYMIZED', id, operationId, JSON.stringify({ reason })],
    );
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
export async function anonymize(id, reason = 'WITHDRAWAL') {
  return withRegistryLock(() => anonymizeLocked(id, reason));
}
async function anonymizeLocked(id, reason) {
  if (!/^[a-f0-9-]{36}$/.test(id) || !['WITHDRAWAL', 'RETENTION'].includes(reason))
    throw new Error('INVALID_ERASURE_REQUEST');
  const policy = await readPolicy();
  if (!policy.approved) throw new Error('APPROVED_POLICY_REQUIRED');
  const db = await database(),
    operationId = randomUUID(),
    dir = process.env.DELETION_LEDGER_DIR ?? '/ledger';
  try {
    const row = (
      await db.query(
        'SELECT a.ends_at,a.status,c.withdrawn_at FROM appointments a JOIN appointment_consents c ON c.appointment_id=a.id WHERE a.id=$1',
        [id],
      )
    ).rows[0];
    if (!row) throw new Error('NOT_FOUND');
    if (reason === 'WITHDRAWAL' && (!row.withdrawn_at || policy.withdrawalErasureApproved !== true))
      throw new Error('VERIFIED_WITHDRAWAL_AND_APPROVED_RULE_REQUIRED');
    if (
      reason === 'RETENTION' &&
      (!policy.appointmentRetentionDays ||
        !['CANCELLED', 'COMPLETED', 'NO_SHOW'].includes(row.status) ||
        Date.now() - row.ends_at.getTime() < policy.appointmentRetentionDays * 86400000)
    )
      throw new Error('RETENTION_NOT_DUE');
    await ledgerSnapshot();
    const ledgerEncryption = await ledgerKey();
    const temp = await mkdtemp(join(tmpdir(), 'clinic-ledger-'));
    try {
      await atomicJson(join(temp, 'intent.json'), {
        version: 1,
        operationId,
        appointmentId: id,
        reason,
        approvedAt: new Date().toISOString(),
      });
      await encryptFile(
        join(temp, 'intent.json'),
        join(dir, operationId + '.gcm'),
        ledgerEncryption.key,
      );
      await registerIntent(operationId, { locked: true, version: ledgerEncryption.version });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    // Durable approved intent PRECEDES DB commit, so restores never resurrect erased PII.
    const changed = await erase(db, id, operationId, reason);
    log('anonymization_completed', { changed });
    return changed;
  } finally {
    await db.end();
  }
}
export async function replayLedger(db, suppliedRegistry) {
  const dir = process.env.DELETION_LEDGER_DIR;
  const registry = suppliedRegistry ?? (await ledgerSnapshot());
  const temp = await mkdtemp(join(tmpdir(), 'clinic-replay-'));
  let applied = 0;
  try {
    for (const entry of registry.entries) {
      const file = entry.id + '.gcm';
      const plain = join(temp, file + '.json');
      await decryptFile(
        join(dir, file),
        plain,
        (await ledgerKey(entry.keyVersion ?? 'legacy')).key,
      );
      const intent = JSON.parse(await readFile(plain, 'utf8'));
      if (
        intent.version !== 1 ||
        !/^[a-f0-9-]{36}$/.test(intent.appointmentId) ||
        !/^[a-f0-9-]{36}$/.test(intent.operationId)
      )
        throw new Error('INVALID_LEDGER');
      if (intent.type === 'WITHDRAWAL') {
        if (
          !/^[a-f0-9-]{36}$/.test(intent.documentId) ||
          !Number.isFinite(Date.parse(intent.withdrawnAt))
        )
          throw new Error('INVALID_LEDGER');
        if (await replayWithdrawal(db, intent)) applied++;
      } else {
        if (intent.type !== undefined || !['WITHDRAWAL', 'RETENTION'].includes(intent.reason))
          throw new Error('INVALID_LEDGER');
        if (await erase(db, intent.appointmentId, intent.operationId, intent.reason)) applied++;
      }
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  log('deletion_ledger_replayed', { applied });
  return applied;
}
async function replayWithdrawal(db, intent) {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    const initial = (
      await tx.query('SELECT doctor_id,service_id FROM appointments WHERE id=$1', [
        intent.appointmentId,
      ])
    ).rows[0];
    if (!initial) {
      await tx.query('ROLLBACK');
      return false;
    }
    await tx.query('SELECT id FROM doctors WHERE id=$1 FOR UPDATE', [initial.doctor_id]);
    await tx.query('SELECT id FROM services WHERE id=$1 FOR UPDATE', [initial.service_id]);
    const current = (
      await tx.query('SELECT doctor_id,service_id FROM appointments WHERE id=$1 FOR UPDATE', [
        intent.appointmentId,
      ])
    ).rows[0];
    if (current.doctor_id !== initial.doctor_id || current.service_id !== initial.service_id)
      throw new Error('CONCURRENT_CHANGE_RETRY');
    const consent = (
      await tx.query(
        'SELECT document_id,withdrawn_at FROM appointment_consents WHERE appointment_id=$1 FOR UPDATE',
        [intent.appointmentId],
      )
    ).rows[0];
    if (!consent || consent.document_id !== intent.documentId)
      throw new Error('WITHDRAWAL_DOCUMENT_MISMATCH');
    if (consent.withdrawn_at) {
      await tx.query('ROLLBACK');
      return false;
    }
    await tx.query('UPDATE appointment_consents SET withdrawn_at=$2 WHERE appointment_id=$1', [
      intent.appointmentId,
      intent.withdrawnAt,
    ]);
    await tx.query(
      'UPDATE appointments SET version=version+1,updated_at=clock_timestamp() WHERE id=$1',
      [intent.appointmentId],
    );
    const actorId =
      intent.actorId &&
      (await tx.query('SELECT id FROM staff_users WHERE id=$1', [intent.actorId])).rowCount
        ? intent.actorId
        : null;
    await tx.query(
      "INSERT INTO audit_events(id,action,entity_type,entity_id,request_id,actor_user_id,metadata) VALUES($1,'CONSENT_WITHDRAWAL_REPLAYED','appointment',$2,$3,$4,'{}')",
      [randomUUID(), intent.appointmentId, intent.requestId ?? intent.operationId, actorId],
    );
    await tx.query('COMMIT');
    return true;
  } catch (e) {
    await tx.query('ROLLBACK');
    throw e;
  } finally {
    tx.release();
  }
}
export async function cleanup() {
  const p = await readPolicy(),
    db = await database();
  try {
    if (!p.approved || !p.technicalGraceSeconds) {
      log('cleanup_dry_run');
      return;
    }
    const cutoff = new Date(Date.now() - p.technicalGraceSeconds * 1000);
    await db.query('DELETE FROM staff_sessions WHERE expires_at<$1', [cutoff]);
    await db.query('DELETE FROM rate_limit_buckets WHERE resets_at<$1', [cutoff]);
    await db.query('DELETE FROM idempotency_keys WHERE expires_at<$1', [cutoff]);
    if (p.unclaimedReceiptRetentionMinutes)
      await db.query(
        'DELETE FROM patient_consent_receipts WHERE appointment_id IS NULL AND expires_at<$1',
        [new Date(Date.now() - p.unclaimedReceiptRetentionMinutes * 60000)],
      );
    if (p.appointmentRetentionDays) {
      const rows = await db.query(
        "SELECT id FROM appointments WHERE status IN ('CANCELLED','COMPLETED','NO_SHOW') AND patient_name_ciphertext IS NOT NULL AND ends_at<$1 ORDER BY id LIMIT 100",
        [new Date(Date.now() - p.appointmentRetentionDays * 86400000)],
      );
      for (const row of rows.rows) await anonymize(row.id, 'RETENTION');
    }
    log('technical_cleanup_completed');
  } finally {
    await db.end();
  }
}
