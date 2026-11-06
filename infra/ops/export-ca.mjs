import { readFile, writeFile, mkdir, chown, chmod, rename, rm } from 'node:fs/promises';
import { X509Certificate, randomUUID } from 'node:crypto';
const certificate = await readFile('/caddy/caddy/pki/authorities/local/root.crt');
if (!new X509Certificate(certificate).ca) throw new Error('LOCAL_CA_CERTIFICATE_REQUIRED');
await mkdir('/tls', { recursive: true });
// A previous export is owned by APP_UID. Create our own inode rather than
// chmod that inode as capability-limited root on subsequent deployments.
const temporary = '/tls/.root-' + randomUUID() + '.crt';
try {
  await writeFile(temporary, certificate, { mode: 0o644, flag: 'wx' });
  await chmod(temporary, 0o644);
  await chown(temporary, Number(process.env.APP_UID ?? 1000), Number(process.env.APP_GID ?? 1000));
  await rename(temporary, '/tls/root.crt');
} finally {
  await rm(temporary, { force: true });
}
console.log(JSON.stringify({ event: 'public_staging_ca_exported', privateKeyExported: false }));
