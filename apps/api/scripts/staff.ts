import { stdin, stdout } from 'node:process';
import { parseEnvironment } from '../src/config/env.js';
import { parseSecurityEnvironment } from '../src/modules/security/config.js';
import { AuthService } from '../src/modules/security/service.js';
import { AccessError } from '../src/modules/security/errors.js';
import { createPrisma } from '../src/infrastructure/prisma.js';

function hiddenQuestion(label: string): Promise<string> {
  stdout.write(label);
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.off('data', handle);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    function handle(buffer: Buffer) {
      for (const character of buffer.toString('utf8')) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('Cancelled'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ' && value.length < 4096) value += character;
      }
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', handle);
  });
}

const action = process.argv[2];
if (
  !stdin.isTTY ||
  !stdout.isTTY ||
  process.argv.length !== 3 ||
  !['bootstrap', 'credentials'].includes(action ?? '')
) {
  console.error(
    'Use an interactive private terminal: staff:bootstrap or staff:credentials. No credentials in argv or pipes.',
  );
  process.exitCode = 1;
} else {
  let client: ReturnType<typeof createPrisma> | undefined;
  try {
    const core = parseEnvironment(process.env);
    const config = parseSecurityEnvironment(process.env);
    client = createPrisma(core.DATABASE_URL);
    const auth = new AuthService(client, config);
    await auth.ready();
    stdout.write(
      'Private operator procedure. Input is hidden. Prepare an offline TOTP base32 key in your authenticator.\n',
    );
    const email = await hiddenQuestion('Staff email: ');
    const password = await hiddenQuestion('New unique password (16–128 characters): ');
    if (password !== (await hiddenQuestion('Repeat password: ')))
      throw new Error('Password mismatch');
    const mfaSecret = await hiddenQuestion('Offline TOTP key (base32, at least 32 characters): ');
    const code = await hiddenQuestion('Current 6-digit TOTP code: ');
    if (action === 'bootstrap') await auth.bootstrap({ email, password, mfaSecret, code });
    else await auth.provisionCredentials({ email, password, mfaSecret, code });
    stdout.write(
      'Credentials provisioned and audited. Previous sessions revoked. Wait for the NEXT TOTP code before logging in.\n',
    );
  } catch (error) {
    console.error(
      error instanceof AccessError
        ? `Operation refused: ${error.code}`
        : 'Operation failed; no credentials were printed.',
    );
    process.exitCode = 1;
  } finally {
    await client?.$disconnect();
  }
}
