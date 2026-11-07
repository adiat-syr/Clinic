import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, lstat } from 'node:fs/promises';
import { resolve, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const names = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: root, encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);
const exact = new Set([
  'package.json',
  'package-lock.json',
  '.npmrc',
  '.dockerignore',
  'tsconfig.base.json',
  '.railwayignore',
]);
const selected = [...new Set(names)].filter(
  (name) =>
    (exact.has(name) || /^(apps|packages|scripts|infra)\//.test(name)) &&
    !/(?:^|\/)(?:tests|node_modules|generated|dist|dist-server)(?:\/|$)/.test(name) &&
    !/\.(?:log|gcm|dump|pem|key|zip|tsbuildinfo)$/.test(name) &&
    !/(?:^|\/)\.env(?:\.|$)/.test(name),
);
await mkdir(join(root, '.deploy'), { recursive: true });
const destination = await mkdtemp(join(root, '.deploy', 'portfolio-source-'));
for (const name of selected) {
  const source = resolve(root, name),
    target = resolve(destination, name);
  if (!source.startsWith(resolve(root) + sep) || !target.startsWith(destination + sep))
    throw new Error('Invalid source path');
  if (!(await lstat(source)).isFile()) throw new Error('Only regular source files are accepted');
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}
console.log(JSON.stringify({ source: destination, files: selected.length }));
