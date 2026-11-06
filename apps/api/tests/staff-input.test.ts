import { describe, expect, it } from 'vitest';
import {
  readValidatedField,
  readExistingStaffEmail,
  readInitialAdminEmail,
} from '../scripts/staff-input.js';
import { credentialsSchema } from '../src/modules/security/input.js';

describe('private operator field validation', () => {
  it('selects only the initial ADMIN after explicit operator confirmation', async () => {
    expect(
      await readInitialAdminEmail(
        async () => 'RECOVER FIRST ADMIN',
        async () => ({ email: 'admin@example.invalid', role: 'ADMIN' }),
      ),
    ).toBe('admin@example.invalid');
  });
  it('does not look up an account without confirmation', async () => {
    let reads = 0;
    await expect(
      readInitialAdminEmail(
        async () => 'yes',
        async () => {
          reads++;
          return null;
        },
      ),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(reads).toBe(0);
  });
  it('does not create an account when the bootstrap marker is missing', async () => {
    await expect(
      readInitialAdminEmail(
        async () => 'RECOVER FIRST ADMIN',
        async () => null,
      ),
    ).rejects.toMatchObject({ code: 'BOOTSTRAP_REQUIRED' });
  });
  it('cannot promote a former administrator whose role was changed', async () => {
    await expect(
      readInitialAdminEmail(
        async () => 'RECOVER FIRST ADMIN',
        async () => ({ email: 'former@example.invalid', role: 'RECEPTIONIST' }),
      ),
    ).rejects.toMatchObject({ code: 'INITIAL_ADMIN_ROLE_CHANGED' });
  });
  it('re-prompts a missing staff email before collecting secrets without exposing addresses', async () => {
    const output: string[] = [],
      checked: string[] = [],
      values = ['missing@example.invalid', '  ADMIN@example.invalid  '];
    const result = await readExistingStaffEmail(
      async () => values.shift() ?? '',
      (message) => {
        output.push(message);
      },
      async (email) => {
        checked.push(email);
        return email === 'admin@example.invalid';
      },
    );
    expect(result).toBe('admin@example.invalid');
    expect(checked).toEqual(['missing@example.invalid', 'admin@example.invalid']);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain('не найден');
    expect(output.join('')).not.toContain('@');
  });
  it('does not report a database failure as a missing employee or retry indefinitely', async () => {
    const output: string[] = [];
    await expect(
      readExistingStaffEmail(
        async () => 'admin@example.invalid',
        (message) => {
          output.push(message);
        },
        async () => {
          throw new Error('offline');
        },
      ),
    ).rejects.toThrow('offline');
    expect(output).toEqual([]);
  });
  it('re-prompts an invalid field without printing submitted values or Zod issues', async () => {
    const secret = 'PRIVATE-INVALID-SECRET',
      output: string[] = [];
    const values = [secret, 'A'.repeat(32)];
    const result = await readValidatedField(
      async () => values.shift() ?? '',
      (message) => {
        output.push(message);
      },
      'Key: ',
      credentialsSchema.shape.mfaSecret,
      'Invalid MFA key',
    );
    expect(result).toBe('A'.repeat(32));
    expect(output).toEqual(['Invalid MFA key\n']);
    expect(output.join('')).not.toContain(secret);
    expect(output.join('')).not.toContain(result);
  });
  it('retains strict validation for pasted OTPs with separators', async () => {
    const output: string[] = [],
      values = ['123 456', '123456'];
    expect(
      await readValidatedField(
        async () => values.shift() ?? '',
        (message) => {
          output.push(message);
        },
        'Code: ',
        credentialsSchema.shape.code,
        'Invalid code format',
      ),
    ).toBe('123456');
    expect(output).toEqual(['Invalid code format\n']);
  });
});
