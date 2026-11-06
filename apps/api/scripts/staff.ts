import { stdin, stdout } from 'node:process';
import { parseEnvironment } from '../src/config/env.js';
import { parseSecurityEnvironment } from '../src/modules/security/config.js';
import { AuthService } from '../src/modules/security/service.js';
import { AccessError } from '../src/modules/security/errors.js';
import { createPrisma } from '../src/infrastructure/prisma.js';
import { credentialsSchema } from '../src/modules/security/input.js';
import { loadSecretFiles } from '../src/config/secrets.js';
import {
  readValidatedField,
  readExistingStaffEmail,
  readInitialAdminEmail,
} from './staff-input.js';

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
  !['bootstrap', 'credentials', 'recover-admin', 'change-email'].includes(action ?? '')
) {
  console.error(
    'Use an interactive private terminal: staff:bootstrap, staff:credentials, staff:recover-admin or staff:email. No credentials in argv or pipes.',
  );
  process.exitCode = 1;
} else {
  let client: ReturnType<typeof createPrisma> | undefined;
  try {
    loadSecretFiles();
    const core = parseEnvironment(process.env);
    const config = parseSecurityEnvironment(process.env);
    const operatorClient = createPrisma(core.DATABASE_URL);
    client = operatorClient;
    const auth = new AuthService(operatorClient, config);
    await auth.ready();
    stdout.write(
      action === 'change-email'
        ? 'Private operator procedure. Input is hidden. Change an existing account email; password, MFA and role are preserved.\n'
        : 'Private operator procedure. Input is hidden. Prepare an offline TOTP base32 key in your authenticator.\n',
    );
    const write = (message: string) => {
      stdout.write(message);
    };
    const email =
      action === 'recover-admin'
        ? await readInitialAdminEmail(hiddenQuestion, async () => {
            const marker = await operatorClient.bootstrapState.findUnique({
              where: { id: true },
              select: { admin: { select: { email: true, role: true } } },
            });
            return marker?.admin ?? null;
          })
        : action === 'credentials' || action === 'change-email'
          ? await readExistingStaffEmail(
              hiddenQuestion,
              write,
              async (email) =>
                (await operatorClient.staffUser.findUnique({
                  where: { email },
                  select: { id: true },
                })) !== null,
            )
          : await readValidatedField(
              hiddenQuestion,
              write,
              'Staff email: ',
              credentialsSchema.shape.email,
              'Invalid email: enter a complete email address. Paste only the value, without quotes.',
            );
    if (action === 'change-email') {
      const newEmail = await readValidatedField(
        hiddenQuestion,
        write,
        'New staff email: ',
        credentialsSchema.shape.email,
        'Неверный формат email. Введите полный адрес без кавычек.',
      );
      while (
        newEmail !==
        credentialsSchema.shape.email.safeParse(await hiddenQuestion('Repeat new email: ')).data
      )
        write('Email не совпадают. Повторите новый адрес; Ctrl+C — отмена.\n');
      if (
        (await hiddenQuestion('Type CHANGE EMAIL to confirm (all sessions will be revoked): ')) !==
        'CHANGE EMAIL'
      )
        throw new AccessError(400, 'CONFIRMATION_REQUIRED');
      await auth.changeStaffEmail({ email, newEmail });
      write(
        'Email changed and audited. Sessions revoked. Log in with the new email, existing password and MFA.\n',
      );
    } else {
      const password = await readValidatedField(
        hiddenQuestion,
        write,
        'New unique password (16–128 characters): ',
        credentialsSchema.shape.password,
        'Invalid password: use 16–128 characters without control characters.',
      );
      while (password !== (await hiddenQuestion('Repeat password: '))) {
        write('Passwords do not match. Repeat the same password; Ctrl+C cancels.\n');
      }
      const mfaSecret = await readValidatedField(
        hiddenQuestion,
        write,
        'Offline TOTP key (base32, at least 32 characters): ',
        credentialsSchema.shape.mfaSecret,
        'Invalid MFA key: use 32–128 uppercase A–Z / 2–7 characters, without spaces, quotes or command text. This is the long key, not the 6-digit code.',
      );
      const code = await readValidatedField(
        hiddenQuestion,
        write,
        'Current 6-digit TOTP code: ',
        credentialsSchema.shape.code,
        'Invalid code format: enter exactly 6 digits from Authenticator without spaces.',
      );
      if (action === 'bootstrap') await auth.bootstrap({ email, password, mfaSecret, code });
      else await auth.provisionCredentials({ email, password, mfaSecret, code });
      if (action === 'recover-admin')
        stdout.write(`Login email (private terminal only): ${email}\n`);
      stdout.write(
        'Credentials provisioned and audited. Previous sessions revoked. Wait for the NEXT TOTP code before logging in.\n',
      );
    }
  } catch (error) {
    const hints: Record<string, string> = {
      EMAIL_ALREADY_USED: 'Этот email уже занят другим сотрудником. Изменения не применены.',
      EMAIL_UNCHANGED: 'Новый email совпадает с текущим. Изменения не применены.',
      CONFIRMATION_REQUIRED: 'Подтверждение не совпало. Операция отменена.',
    };
    console.error(
      error instanceof AccessError
        ? `Operation refused: ${error.code}${hints[error.code] ? '. ' + hints[error.code] : ''}`
        : 'Operation failed; no credentials were printed.',
    );
    process.exitCode = 1;
  } finally {
    await client?.$disconnect();
  }
}
