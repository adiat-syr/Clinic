import { randomUUID } from 'node:crypto';
import { database, secret, log } from './lib.mjs';

export async function rotateKeys() {
  // Read keys only from private mounts. HMAC key intentionally remains stable.
  for (const name of ['AUTH_MFA_KEY', 'AUTH_CSRF_KEY', 'CONTACT_KEYS_JSON', 'BOOKING_HMAC_KEY'])
    if (!process.env[name]) process.env[name] = await secret(name);
  if (process.env.AUTH_MFA_KEYS_JSON_FILE && !process.env.AUTH_MFA_KEYS_JSON)
    process.env.AUTH_MFA_KEYS_JSON = await secret('AUTH_MFA_KEYS_JSON');
  const { parseSecurityEnvironment } =
    await import('../../apps/api/dist/modules/security/config.js');
  const { parsePrivacyEnvironment, ContactPrivacy } =
    await import('../../apps/api/dist/modules/booking/privacy.js');
  const { openMfa, sealMfa } = await import('../../apps/api/dist/modules/security/crypto.js');
  const security = parseSecurityEnvironment(process.env),
    privacy = new ContactPrivacy(parsePrivacyEnvironment(process.env));
  const db = await database();
  let contactCount = 0,
    mfaCount = 0;
  try {
    // Each unit gets a dedicated connection and the existing doctor/service order.
    const appointments = await db.query(
      'SELECT id,doctor_id,service_id FROM appointments WHERE encryption_key_version IS NOT NULL AND encryption_key_version<>$1 ORDER BY doctor_id,service_id,id',
      [privacy.config.activeVersion],
    );
    for (const initial of appointments.rows) {
      const tx = await db.connect();
      try {
        await tx.query('BEGIN');
        await tx.query('SELECT id FROM doctors WHERE id=$1 FOR UPDATE', [initial.doctor_id]);
        await tx.query('SELECT id FROM services WHERE id=$1 FOR UPDATE', [initial.service_id]);
        const row = (
          await tx.query('SELECT * FROM appointments WHERE id=$1 FOR UPDATE', [initial.id])
        ).rows[0];
        if (row.doctor_id !== initial.doctor_id || row.service_id !== initial.service_id) {
          await tx.query('ROLLBACK');
          continue;
        }
        if (
          row.encryption_key_version &&
          row.encryption_key_version !== privacy.config.activeVersion
        ) {
          const sealed = privacy.sealContacts({
            name: privacy.open(row.patient_name_ciphertext, row.encryption_key_version, 'name'),
            phone: privacy.open(row.phone_ciphertext, row.encryption_key_version, 'phone'),
          });
          await tx.query(
            'UPDATE appointments SET patient_name_ciphertext=$1,phone_ciphertext=$2,encryption_key_version=$3 WHERE id=$4',
            [
              sealed.patientNameCiphertext,
              sealed.phoneCiphertext,
              sealed.encryptionKeyVersion,
              row.id,
            ],
          );
          contactCount++;
        }
        await tx.query('COMMIT');
      } catch (e) {
        await tx.query('ROLLBACK');
        throw e;
      } finally {
        tx.release();
      }
    }
    const receipts = await db.query(
      'SELECT code_hash FROM patient_consent_receipts WHERE encryption_key_version<>$1 ORDER BY code_hash',
      [privacy.config.activeVersion],
    );
    for (const r of receipts.rows) {
      const tx = await db.connect();
      try {
        await tx.query('BEGIN');
        await tx.query("SET LOCAL clinic.rotate_keys='on'");
        const row = (
          await tx.query('SELECT * FROM patient_consent_receipts WHERE code_hash=$1 FOR UPDATE', [
            r.code_hash,
          ])
        ).rows[0];
        if (row && row.encryption_key_version !== privacy.config.activeVersion) {
          const sealed = privacy.sealContacts({
            name: privacy.open(row.patient_name_ciphertext, row.encryption_key_version, 'name'),
            phone: privacy.open(row.phone_ciphertext, row.encryption_key_version, 'phone'),
          });
          await tx.query(
            'UPDATE patient_consent_receipts SET patient_name_ciphertext=$1,phone_ciphertext=$2,encryption_key_version=$3 WHERE code_hash=$4',
            [
              sealed.patientNameCiphertext,
              sealed.phoneCiphertext,
              sealed.encryptionKeyVersion,
              row.code_hash,
            ],
          );
          contactCount++;
        }
        await tx.query('COMMIT');
      } catch (e) {
        await tx.query('ROLLBACK');
        throw e;
      } finally {
        tx.release();
      }
    }
    if (security.mfaWriteKey) {
      const users = await db.query(
        'SELECT id FROM staff_users WHERE mfa_secret_ciphertext IS NOT NULL ORDER BY id',
      );
      for (const u of users.rows) {
        const tx = await db.connect();
        try {
          await tx.query('BEGIN');
          await tx.query('SELECT pg_advisory_xact_lock(75003,1)');
          const row = (
            await tx.query(
              'SELECT id,mfa_secret_ciphertext FROM staff_users WHERE id=$1 FOR UPDATE',
              [u.id],
            )
          ).rows[0];
          const envelope = Buffer.from(row.mfa_secret_ciphertext);
          if (
            envelope[0] === 2 &&
            envelope.subarray(2, 2 + envelope[1]).toString('utf8') === security.mfaWriteKey.id
          ) {
            await tx.query('COMMIT');
            continue;
          }
          const value = openMfa(
            row.mfa_secret_ciphertext,
            security.mfaKey,
            row.id,
            security.mfaKeys,
          );
          const ciphertext = sealMfa(
            value,
            security.mfaWriteKey.key,
            row.id,
            security.mfaWriteKey.id,
          );
          await tx.query('UPDATE staff_users SET mfa_secret_ciphertext=$1 WHERE id=$2', [
            ciphertext,
            row.id,
          ]);
          await tx.query('COMMIT');
          mfaCount++;
        } catch (e) {
          await tx.query('ROLLBACK');
          throw e;
        } finally {
          tx.release();
        }
      }
    }
    await db.query(
      "INSERT INTO audit_events(id,action,entity_type,request_id,metadata) VALUES($1,'ENCRYPTION_KEYS_ROTATED','system',$2,'{}')",
      [randomUUID(), randomUUID()],
    );
    log('key_rotation_completed', { contactCount, mfaCount });
    return { contactCount, mfaCount };
  } finally {
    await db.end();
  }
}
