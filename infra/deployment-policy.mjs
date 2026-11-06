import { isIP } from 'node:net';

export function validateDeployment(v, mode) {
  for (const key of ['APP_UID', 'APP_GID']) {
    if (!/^[1-9]\d{0,9}$/.test(v[key] ?? '') || Number(v[key]) > 2147483647)
      throw new Error('UNPRIVILEGED_DEPLOYMENT_USER_REQUIRED');
  }
  if (mode !== 'production') return;
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v.SITE_HOST ?? '') ||
    /\.(invalid|test|localhost|example)$/.test(v.SITE_HOST) ||
    isIP(v.SITE_HOST) ||
    v.PUBLIC_ORIGIN !== `https://${v.SITE_HOST}` ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.ACME_EMAIL ?? '') ||
    /@(example\.(invalid|test|com)|localhost)$/.test(v.ACME_EMAIL)
  )
    throw new Error('PRODUCTION_DOMAIN_OR_CONTACT_REQUIRED');
  if (v.HTTP_PORT !== '80' || v.HTTPS_PORT !== '443')
    throw new Error('STANDARD_TLS_PORTS_REQUIRED');
  if (v.BACKUP_DIR === v.SECONDARY_BACKUP_DIR || v.LEDGER_DIR === v.LEDGER_CHECKPOINT_DIR)
    throw new Error('INDEPENDENT_RECOVERY_PATHS_REQUIRED');
}
export function validateRollbackLabel(api, web) {
  if (api !== '2' || web !== '2') throw new Error('ROLLBACK_PRIVACY_PROTOCOL_INCOMPATIBLE');
}
