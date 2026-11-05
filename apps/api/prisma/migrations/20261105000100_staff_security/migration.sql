BEGIN;
CREATE TABLE bootstrap_state (
  id boolean NOT NULL DEFAULT true,
  admin_user_id uuid NOT NULL,
  completed_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT bootstrap_state_pkey PRIMARY KEY (id),
  CONSTRAINT bootstrap_singleton CHECK (id = true AND isfinite(completed_at)),
  CONSTRAINT bootstrap_state_admin_user_id_fkey FOREIGN KEY (admin_user_id) REFERENCES staff_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX bootstrap_state_admin_user_id_key ON bootstrap_state(admin_user_id);
CREATE TABLE rate_limit_buckets (
  key_hash char(64) NOT NULL,
  attempts integer NOT NULL,
  resets_at timestamptz(3) NOT NULL,
  CONSTRAINT rate_limit_buckets_pkey PRIMARY KEY (key_hash),
  CONSTRAINT rate_limit_valid CHECK (key_hash ~ '^[0-9a-f]{64}$' AND attempts > 0 AND isfinite(resets_at))
);
CREATE INDEX rate_limit_buckets_resets_at_idx ON rate_limit_buckets(resets_at);

CREATE FUNCTION revoke_staff_security_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.role IS DISTINCT FROM OLD.role
    OR NEW.is_active IS DISTINCT FROM OLD.is_active OR NEW.mfa_enabled IS DISTINCT FROM OLD.mfa_enabled
    OR NEW.mfa_secret_ciphertext IS DISTINCT FROM OLD.mfa_secret_ciphertext THEN
    UPDATE staff_sessions SET revoked_at = clock_timestamp() WHERE user_id = OLD.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER staff_security_revokes_sessions AFTER UPDATE ON staff_users
  FOR EACH ROW EXECUTE FUNCTION revoke_staff_security_sessions();

CREATE FUNCTION preserve_bootstrap_marker() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Bootstrap marker is immutable' USING ERRCODE='23514', CONSTRAINT='bootstrap_marker_immutable';
END;
$$;
CREATE TRIGGER bootstrap_marker_immutable BEFORE UPDATE OR DELETE ON bootstrap_state
  FOR EACH ROW EXECUTE FUNCTION preserve_bootstrap_marker();
COMMIT;
