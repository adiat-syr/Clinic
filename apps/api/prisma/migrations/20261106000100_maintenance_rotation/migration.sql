-- Evidence stays immutable to runtime. A separately granted maintenance role may
-- rotate ciphertext only, under an explicit transaction flag, preserving identity.
CREATE OR REPLACE FUNCTION guard_patient_consent_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE may_rotate boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname='clinic_maintenance'
    AND pg_has_role(session_user,r.oid,'member'))
    AND current_setting('clinic.rotate_keys',true)='on' INTO may_rotate;
  IF may_rotate AND ROW(NEW.code_hash,NEW.document_id,NEW.locale,NEW.accepted_at,NEW.expires_at,
        NEW.fingerprint,NEW.consumed_at,NEW.appointment_id)
      IS NOT DISTINCT FROM ROW(OLD.code_hash,OLD.document_id,OLD.locale,OLD.accepted_at,OLD.expires_at,
        OLD.fingerprint,OLD.consumed_at,OLD.appointment_id) THEN
    RETURN NEW;
  END IF;
  IF ROW(NEW.code_hash,NEW.document_id,NEW.locale,NEW.accepted_at,NEW.expires_at,
         NEW.patient_name_ciphertext,NEW.phone_ciphertext,NEW.encryption_key_version,NEW.fingerprint)
     IS DISTINCT FROM ROW(OLD.code_hash,OLD.document_id,OLD.locale,OLD.accepted_at,OLD.expires_at,
         OLD.patient_name_ciphertext,OLD.phone_ciphertext,OLD.encryption_key_version,OLD.fingerprint)
     OR OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Consent evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;
