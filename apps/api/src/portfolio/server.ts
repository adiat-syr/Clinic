import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createPortfolioGateway } from './gateway.js';

if (process.env.NODE_ENV !== 'production' || process.env.DATA_MODE !== 'synthetic')
  throw new Error('Isolated synthetic production build required');
const port = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .parse(process.env.PORT ?? '8080');
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  API_HOST: '127.0.0.1',
  API_PORT: '3001',
  TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
};
delete childEnv.DEMO_BOOTSTRAP_URL;
const api = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
  env: childEnv,
  stdio: 'inherit',
  windowsHide: true,
});
const server = createPortfolioGateway(
  'http://127.0.0.1:3001',
  fileURLToPath(new URL('../../../web/dist/', import.meta.url)),
).listen(port, '0.0.0.0', () => console.log(JSON.stringify({ event: 'portfolio_listening' })));
function stop() {
  server.closeIdleConnections();
  server.close();
  api.kill('SIGTERM');
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
api.once('exit', (code) => {
  server.close();
  process.exitCode = code ?? 1;
});
