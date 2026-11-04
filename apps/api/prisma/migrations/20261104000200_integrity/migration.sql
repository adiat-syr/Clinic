BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE services ADD CONSTRAINT services_valid_offer CHECK (
  duration_minutes BETWEEN 1 AND 1440 AND price_kzt BETWEEN 0 AND 9999999999.99
);
ALTER TABLE availability_windows
  ADD CONSTRAINT availability_valid_interval CHECK (
    isfinite(starts_at) AND isfinite(ends_at) AND starts_at < ends_at
    AND ends_at - starts_at <= interval '24 hours'
  ),
  ADD CONSTRAINT availability_no_overlap EXCLUDE USING gist (
    doctor_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&
  );
ALTER TABLE appointments
  ADD CONSTRAINT appointment_valid_interval CHECK (
    isfinite(starts_at) AND isfinite(ends_at) AND starts_at < ends_at
    AND duration_minutes_snapshot BETWEEN 1 AND 1440
    AND ends_at - starts_at = make_interval(mins => duration_minutes_snapshot)
  ),
  ADD CONSTRAINT appointment_valid_values CHECK (price_kzt_snapshot BETWEEN 0 AND 9999999999.99 AND version > 0),
  ADD CONSTRAINT appointment_contacts CHECK (
    (patient_name_ciphertext IS NOT NULL AND octet_length(patient_name_ciphertext) >= 30
      AND phone_ciphertext IS NOT NULL AND octet_length(phone_ciphertext) >= 30
      AND encryption_key_version IS NOT NULL AND length(encryption_key_version) BETWEEN 1 AND 80
      AND anonymized_at IS NULL)
    OR (patient_name_ciphertext IS NULL AND phone_ciphertext IS NULL
      AND encryption_key_version IS NULL AND anonymized_at IS NOT NULL)
  ),
  ADD CONSTRAINT appointments_no_overlap EXCLUDE USING gist (
    doctor_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status <> 'CANCELLED');

ALTER TABLE staff_users
  ADD CONSTRAINT staff_email_normalized CHECK (email = lower(btrim(email)) AND length(email) > 3),
  ADD CONSTRAINT staff_mfa_valid CHECK (
    (NOT mfa_enabled OR mfa_secret_ciphertext IS NOT NULL)
    AND (mfa_last_used_counter IS NULL OR mfa_last_used_counter >= 0)
  );
ALTER TABLE staff_sessions ADD CONSTRAINT session_valid CHECK (
  token_hash ~ '^[0-9a-f]{64}$' AND expires_at > created_at AND last_seen_at >= created_at
  AND ((auth_stage = 'CHALLENGE' AND mfa_verified_at IS NULL)
    OR (auth_stage = 'AUTHENTICATED' AND mfa_verified_at IS NOT NULL))
);
ALTER TABLE consent_documents ADD CONSTRAINT consent_document_valid CHECK (
  length(version) > 0 AND length(text_ru) > 0 AND length(text_kk) > 0
  AND content_sha256 ~ '^[0-9a-f]{64}$'
  AND (retired_at IS NULL OR retired_at >= published_at)
);
CREATE UNIQUE INDEX consent_documents_one_current ON consent_documents ((true))
  WHERE retired_at IS NULL;
ALTER TABLE appointment_consents ADD CONSTRAINT consent_withdrawal_valid CHECK (
  withdrawn_at IS NULL OR withdrawn_at >= accepted_at
);
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_valid CHECK (
  key_hash ~ '^[0-9a-f]{64}$' AND request_hmac ~ '^[0-9a-f]{64}$' AND expires_at > created_at
);
ALTER TABLE audit_events ADD CONSTRAINT audit_metadata_valid CHECK (
  jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 2048
  AND length(action) BETWEEN 1 AND 80 AND length(entity_type) BETWEEN 1 AND 80
);

CREATE FUNCTION preserve_consent_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.text_ru IS DISTINCT FROM OLD.text_ru OR NEW.text_kk IS DISTINCT FROM OLD.text_kk
    OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
    OR NEW.published_at IS DISTINCT FROM OLD.published_at
    OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN
    RAISE EXCEPTION 'Published consent is immutable' USING ERRCODE = '23514', CONSTRAINT = 'consent_document_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER consent_document_immutable BEFORE UPDATE ON consent_documents
  FOR EACH ROW EXECUTE FUNCTION preserve_consent_document();

CREATE FUNCTION preserve_consent_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.appointment_id IS DISTINCT FROM OLD.appointment_id OR NEW.document_id IS DISTINCT FROM OLD.document_id
    OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at OR NEW.locale IS DISTINCT FROM OLD.locale
    OR NEW.method IS DISTINCT FROM OLD.method
    OR (OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at) THEN
    RAISE EXCEPTION 'Consent evidence is immutable' USING ERRCODE = '23514', CONSTRAINT = 'consent_evidence_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER consent_evidence_immutable BEFORE UPDATE ON appointment_consents
  FOR EACH ROW EXECUTE FUNCTION preserve_consent_evidence();

-- Deferred: permits appointment + consent insertion in one transaction, but never an orphan commit.
CREATE FUNCTION require_appointment_consent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE appointment_key uuid;
BEGIN
  IF TG_TABLE_NAME = 'appointments' THEN appointment_key := NEW.id;
  ELSE appointment_key := OLD.appointment_id; END IF;
  IF EXISTS (SELECT 1 FROM appointments WHERE id = appointment_key)
    AND NOT EXISTS (SELECT 1 FROM appointment_consents WHERE appointment_id = appointment_key) THEN
    RAISE EXCEPTION 'Appointment requires consent' USING ERRCODE = '23514', CONSTRAINT = 'appointment_requires_consent';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER appointment_requires_consent AFTER INSERT OR UPDATE ON appointments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_appointment_consent();
CREATE CONSTRAINT TRIGGER appointment_preserves_consent AFTER DELETE OR UPDATE ON appointment_consents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_appointment_consent();

CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit is append-only' USING ERRCODE = '23514', CONSTRAINT = 'audit_append_only';
END;
$$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

COMMIT;
