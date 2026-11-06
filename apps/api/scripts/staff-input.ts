import type { z } from 'zod';
import { credentialsSchema } from '../src/modules/security/input.js';
import { AccessError } from '../src/modules/security/errors.js';

// Never print Zod issues: they can contain submitted secrets.
export async function readValidatedField<T>(
  ask: (label: string) => Promise<string>,
  write: (message: string) => void,
  label: string,
  schema: z.ZodType<T>,
  help: string,
): Promise<T> {
  for (;;) {
    const result = schema.safeParse(await ask(label));
    if (result.success) return result.data;
    write(help + '\n');
  }
}

// Operator-only preflight. The service still checks existence in its transaction.
export async function readExistingStaffEmail(
  ask: (label: string) => Promise<string>,
  write: (message: string) => void,
  exists: (email: string) => Promise<boolean>,
): Promise<string> {
  for (;;) {
    const email = await readValidatedField(
      ask,
      write,
      'Staff email: ',
      credentialsSchema.shape.email,
      'Неверный формат email. Введите полный адрес без кавычек.',
    );
    if (await exists(email)) return email;
    write(
      'Сотрудник с таким email не найден в подключённой БД. Введите email, указанный при создании аккаунта. Если адрес верный, проверьте подключение к БД. Ctrl+C — отмена.\n',
    );
  }
}

export async function readInitialAdminEmail(
  ask: (label: string) => Promise<string>,
  lookup: () => Promise<{ email: string; role: string } | null>,
): Promise<string> {
  if (
    (await ask(
      'Type RECOVER FIRST ADMIN to reset the initial administrator (Ctrl+C cancels): ',
    )) !== 'RECOVER FIRST ADMIN'
  )
    throw new AccessError(400, 'CONFIRMATION_REQUIRED');
  const admin = await lookup();
  if (!admin) throw new AccessError(409, 'BOOTSTRAP_REQUIRED');
  if (admin.role !== 'ADMIN') throw new AccessError(409, 'INITIAL_ADMIN_ROLE_CHANGED');
  return admin.email;
}
