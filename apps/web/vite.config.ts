import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig(({ mode, command }) => {
  // Loading root .env's NODE_ENV=development during a build selects React's dev runtime.
  // Production artifacts must be independent of the local development server settings.
  if (command === 'build') {
    process.env.NODE_ENV = 'production';
    delete process.env.VITE_USER_NODE_ENV;
  }
  const env = command === 'serve' ? loadEnv(mode, workspaceRoot, 'API_') : {};
  const apiPort = Number(process.env.API_PORT ?? env.API_PORT ?? 3001);
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new Error('API_PORT must be a valid TCP port');
  }

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target: `http://127.0.0.1:${apiPort}` } },
    },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true },
    build: { target: 'es2022' },
  };
});
