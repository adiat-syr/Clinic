CREATE TABLE patient_consent_receipts (
  code_hash char(64) PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  document_id uuid NOT NULL REFERENCES consent_documents(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  locale "Locale" NOT NULL,
  accepted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  patient_name_ciphertext bytea NOT NULL CHECK (octet_length(patient_name_ciphertext) BETWEEN 30 AND 2048),
  phone_ciphertext bytea NOT NULL CHECK (octet_length(phone_ciphertext) BETWEEN 30 AND 2048),
  encryption_key_version varchar(80) NOT NULL CHECK (length(encryption_key_version) > 0),
  fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  consumed_at timestamptz,
  appointment_id uuid UNIQUE REFERENCES appointments(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT patient_consent_receipt_lifetime CHECK (expires_at = accepted_at + interval '5 minutes'),
  CONSTRAINT patient_consent_receipt_consumption CHECK (
    (consumed_at IS NULL AND appointment_id IS NULL) OR
    (consumed_at IS NOT NULL AND appointment_id IS NOT NULL AND consumed_at >= accepted_at AND consumed_at < expires_at)
  )
);
CREATE INDEX patient_consent_receipts_document_id_idx ON patient_consent_receipts(document_id);
CREATE INDEX patient_consent_receipts_expires_at_idx ON patient_consent_receipts(expires_at);

-- Evidence is immutable. Consumption is a single transition in the booking transaction.
CREATE FUNCTION guard_patient_consent_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.code_hash, NEW.document_id, NEW.locale, NEW.accepted_at, NEW.expires_at,
         NEW.patient_name_ciphertext, NEW.phone_ciphertext, NEW.encryption_key_version, NEW.fingerprint)
     IS DISTINCT FROM
     ROW(OLD.code_hash, OLD.document_id, OLD.locale, OLD.accepted_at, OLD.expires_at,
         OLD.patient_name_ciphertext, OLD.phone_ciphertext, OLD.encryption_key_version, OLD.fingerprint)
     OR OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Consent evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER patient_consent_receipt_immutable BEFORE UPDATE ON patient_consent_receipts
FOR EACH ROW EXECUTE FUNCTION guard_patient_consent_receipt();
