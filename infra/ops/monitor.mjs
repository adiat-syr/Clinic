import https from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { database, readFile, atomicJson, log, setting } from './lib.mjs';
import { backup } from './backup.mjs';
import { cleanup } from './maintenance.mjs';
import { ledgerHealth } from './ledger.mjs';
import { reconcilePrivacy } from './reconcile-privacy.mjs';

export async function monitor() {
  const db = await database();
  const alerts = [];
  let counts = {},
    certificateDays = null;
  try {
    const query = await db.query(
      `SELECT
      (SELECT count(*)::int FROM appointments WHERE status='PENDING' AND created_at<clock_timestamp()-($1::int*interval '1 minute')) AS pending,
      (SELECT count(*)::int FROM audit_events WHERE action IN ('AUTH_LOGIN_FAILED','AUTH_MFA_FAILED') AND created_at>clock_timestamp()-interval '15 minutes') AS auth_failures`,
      [setting('PENDING_WARNING_MINUTES', 60, 1, 10080)],
    );
    counts = query.rows[0];
    if (counts.pending > 0) alerts.push('PENDING_BACKLOG');
    if (counts.auth_failures >= setting('AUTH_FAILURE_WARNING', 20, 1, 10000))
      alerts.push('AUTH_FAILURE_SPIKE');
    const health = await fetch(
      process.env.INTERNAL_READY_URL ?? 'http://api:3001/api/v1/health/ready',
      { signal: AbortSignal.timeout(5000) },
    );
    if (!health.ok) alerts.push('API_NOT_READY');
    const ca = process.env.TLS_CA_FILE ? await readFile(process.env.TLS_CA_FILE) : undefined;
    const status = await new Promise((resolve, reject) => {
      const request = https.get(
        {
          hostname: process.env.TLS_CONNECT_HOST ?? 'web',
          port: setting('TLS_CONNECT_PORT', 443, 1, 65535),
          servername: process.env.SITE_HOST,
          path: '/api/v1/health/ready',
          ca,
          timeout: 5000,
          agent: false,
        },
        (response) => {
          const cert = response.socket.getPeerCertificate();
          certificateDays = (Date.parse(cert.valid_to) - Date.now()) / 86400000;
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on('timeout', () => request.destroy());
      request.on('error', reject);
    });
    if (status !== 200) alerts.push('HTTPS_NOT_READY');
    if (!Number.isFinite(certificateDays)) alerts.push('CERTIFICATE_UNAVAILABLE');
    else if (certificateDays < setting('CERT_WARNING_DAYS', 7, 0, 60))
      alerts.push('CERTIFICATE_EXPIRING');
    const state = JSON.parse(
      await readFile(join(process.env.BACKUP_DIR ?? '/backups', 'status.json'), 'utf8'),
    );
    if (
      !state.ok ||
      !state.lastSuccess ||
      !Number.isFinite(Date.parse(state.lastSuccess)) ||
      Date.now() - Date.parse(state.lastSuccess) >
        setting('BACKUP_MAX_AGE_SECONDS', 90000, 60, 31536000) * 1000
    )
      alerts.push('BACKUP_STALE_OR_FAILED');
    await ledgerHealth();
    const replay = JSON.parse(
      await readFile(join(process.env.BACKUP_DIR ?? '/backups', 'privacy-status.json'), 'utf8'),
    );
    if (
      !replay.ok ||
      !Number.isFinite(Date.parse(replay.lastSuccess)) ||
      Date.now() - Date.parse(replay.lastSuccess) > 300000
    )
      alerts.push('PRIVACY_REPLAY_STALE_OR_FAILED');
  } catch {
    alerts.push('MONITOR_CHECK_FAILED');
  } finally {
    await db.end();
  }
  const result = {
    checkedAt: new Date().toISOString(),
    ok: alerts.length === 0,
    alerts,
    counts,
    certificateDays,
  };
  if (process.env.MONITOR_STATUS_FILE) await atomicJson(process.env.MONITOR_STATUS_FILE, result);
  log(alerts.length ? 'operational_alert' : 'operational_healthy', {
    alerts,
    counts,
    certificateDays,
  });
  return result;
}
export async function scheduler() {
  const abort = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => abort.abort());
  const interval = setting('BACKUP_INTERVAL_SECONDS', 86400, 60, 604800),
    monitorInterval = setting('MONITOR_INTERVAL_SECONDS', 60, 5, 60);
  const heartbeat = () =>
    atomicJson(join(process.env.BACKUP_DIR ?? '/backups', 'heartbeat.json'), {
      checkedAt: new Date().toISOString(),
    });
  await heartbeat();
  const timer = setInterval(() => {
    void heartbeat().catch(() => log('heartbeat_write_failed'));
  }, 15000);
  timer.unref();
  let lastBackup = 0;
  while (!abort.signal.aborted) {
    if (Date.now() - lastBackup >= interval * 1000) {
      const startedAt = Date.now();
      try {
        await backup();
        lastBackup = startedAt;
      } catch {
        log('backup_scheduler_failure');
      }
    }
    try {
      await reconcilePrivacy();
      await atomicJson(join(process.env.BACKUP_DIR ?? '/backups', 'privacy-status.json'), {
        ok: true,
        lastSuccess: new Date().toISOString(),
      });
    } catch {
      log('privacy_replay_failure');
      await atomicJson(join(process.env.BACKUP_DIR ?? '/backups', 'privacy-status.json'), {
        ok: false,
        lastFailure: new Date().toISOString(),
      }).catch(() => {});
    }
    try {
      await cleanup();
    } catch {
      log('cleanup_scheduler_failure');
    }
    try {
      await monitor();
    } catch {
      log('monitor_scheduler_failure');
    }
    try {
      await sleep(monitorInterval * 1000, undefined, {
        signal: abort.signal,
      });
    } catch {
      break;
    }
  }
  clearInterval(timer);
  log('scheduler_stopped');
}
