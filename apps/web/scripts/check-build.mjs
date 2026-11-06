import { readdir } from 'node:fs/promises';
const files = await readdir(new URL('../dist/assets/', import.meta.url));
if (files.some((name) => /jsx-dev-runtime|react[.-]development/i.test(name)))
  throw new Error('Development React runtime in production build');
console.log('Production browser artifact excludes development runtime chunks.');
