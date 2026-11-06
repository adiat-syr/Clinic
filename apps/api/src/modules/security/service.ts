import { randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient, StaffRole } from '../../generated/prisma/client.js';
import { withTransaction, type Transaction } from '../booking/transaction.js';
import type { SecurityConfig } from './config.js';
import { AccessError, validated } from './errors.js';
import {
  hashPassword,
  hashToken,
  token,
  verifyPassword,
  openMfa,
  sealMfa,
  totpCounter,
} from './crypto.js';
import { lockStaff, lockStaffManagement, writeAudit } from './repository.js';
import {
  credentialsSchema,
  loginSchema,
  mfaCodeSchema,
  passwordChangeSchema,
  operatorEmailChangeSchema,
} from './input.js';
import { DatabaseRateLimiter } from './rate-limit.js';

const MINUTE = 60000;
export interface StaffIdentity {
  id: string;
  email: string;
  role: StaffRole;
}
interface SessionOptions {
  requestId: string;
  touch?: boolean;
  roles?: StaffRole[];
  challenge?: boolean;
  staffTargets?: string[];
  staffManagement?: boolean;
}

export class AuthService {
  private readonly dummyHash: Promise<string>;
  readonly limiter: DatabaseRateLimiter;
  constructor(
    readonly client: PrismaClient,
    readonly config: SecurityConfig,
    readonly now: () => Date = () => new Date(),
  ) {
    this.dummyHash = hashPassword(randomBytes(32).toString('hex'));
    this.limiter = new DatabaseRateLimiter(client, config.csrfKey, now);
  }
  async ready() {
    await this.dummyHash;
  }

  async withSession<T>(
    raw: string | null,
    options: SessionOptions,
    work: (tx: Transaction, actor: StaffIdentity, sessionId: string) => Promise<T>,
  ): Promise<T> {
    if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) throw new AccessError(401, 'UNAUTHORIZED');
    const tokenHash = hashToken(raw);
    const initial = await this.client.staffSession.findUnique({
      where: { tokenHash },
      select: { userId: true },
    });
    if (!initial) throw new AccessError(401, 'UNAUTHORIZED');
    return withTransaction(this.client, async (tx) => {
      if (options.staffManagement) await lockStaffManagement(tx);
      await lockStaff(tx, [initial.userId, ...(options.staffTargets ?? [])]);
      await tx.$queryRaw`SELECT id FROM staff_sessions WHERE token_hash=${tokenHash} FOR UPDATE`;
      const session = await tx.staffSession.findUnique({
        where: { tokenHash },
        include: { user: true },
      });
      const now = this.now();
      if (
        !session ||
        session.revokedAt ||
        session.expiresAt <= now ||
        now.getTime() - session.lastSeenAt.getTime() >= 30 * MINUTE ||
        !session.user.isActive ||
        !session.user.mfaEnabled ||
        !session.user.mfaSecretCiphertext ||
        (!options.challenge && (session.authStage !== 'AUTHENTICATED' || !session.mfaVerifiedAt))
      )
        throw new AccessError(401, 'UNAUTHORIZED');
      if (options.roles && !options.roles.includes(session.user.role))
        throw new AccessError(403, 'FORBIDDEN');
      if (options.touch !== false)
        await tx.staffSession.update({ where: { id: session.id }, data: { lastSeenAt: now } });
      return work(
        tx,
        { id: session.user.id, email: session.user.email, role: session.user.role },
        session.id,
      );
    });
  }

  async login(input: unknown, ip: string, requestId: string, oldToken: string | null) {
    const command = validated(loginSchema, input);
    await this.limiter.require('login-ip', ip, 30, 15 * MINUTE);
    await this.limiter.require('login-account', command.email, 10, 15 * MINUTE);
    const snapshot = await this.client.staffUser.findUnique({ where: { email: command.email } });
    const usable =
      snapshot?.isActive &&
      snapshot.mfaEnabled &&
      snapshot.mfaSecretCiphertext &&
      snapshot.passwordHash.startsWith('$argon2id$');
    const valid = await verifyPassword(
      usable ? snapshot.passwordHash : await this.dummyHash,
      command.password,
    );
    if (!usable || !valid || !snapshot) {
      await this.client.$transaction((tx) =>
        writeAudit(tx, 'AUTH_LOGIN_FAILED', 'auth', null, requestId, null),
      );
      throw new AccessError(401, 'LOGIN_FAILED');
    }
    const raw = token();
    return withTransaction(this.client, async (tx) => {
      await lockStaff(tx, [snapshot.id]);
      const user = await tx.staffUser.findUniqueOrThrow({ where: { id: snapshot.id } });
      if (
        !user.isActive ||
        !user.mfaEnabled ||
        user.passwordHash !== snapshot.passwordHash ||
        !user.mfaSecretCiphertext
      )
        throw new AccessError(401, 'LOGIN_FAILED');
      if (oldToken)
        await tx.staffSession.updateMany({
          where: { userId: user.id, tokenHash: hashToken(oldToken), revokedAt: null },
          data: { revokedAt: this.now() },
        });
      const now = this.now();
      await tx.staffSession.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(raw),
          authStage: 'CHALLENGE',
          createdAt: now,
          lastSeenAt: now,
          expiresAt: new Date(now.getTime() + 5 * MINUTE),
        },
      });
      await writeAudit(tx, 'AUTH_PASSWORD_ACCEPTED', 'staff', user.id, requestId, user.id);
      return { token: raw };
    });
  }

  async verifyMfa(raw: string | null, input: unknown, ip: string, requestId: string) {
    const command = validated(mfaCodeSchema, input);
    await this.limiter.require('mfa-ip', ip, 30, 5 * MINUTE);
    await this.limiter.require('mfa-session', raw ?? 'missing', 5, 5 * MINUTE);
    const replacement = token();
    const outcome = await this.withSession(
      raw,
      { requestId, challenge: true },
      async (tx, actor, sessionId) => {
        const session = await tx.staffSession.findUniqueOrThrow({ where: { id: sessionId } });
        if (session.authStage !== 'CHALLENGE') throw new AccessError(401, 'INVALID_MFA');
        // Only a live password-verified challenge may spend the subject's MFA quota.
        // Failed-code outcomes return false and commit this counter with their audit.
        // Reuse the held connection: a nested pool checkout can deadlock a saturated pool.
        await this.limiter.require('mfa-account', actor.id, 5, 5 * MINUTE, tx);
        const user = await tx.staffUser.findUniqueOrThrow({ where: { id: actor.id } });
        if (!user.mfaSecretCiphertext) throw new AccessError(401, 'INVALID_MFA');
        const counter = totpCounter(
          openMfa(user.mfaSecretCiphertext, this.config.mfaKey, user.id, this.config.mfaKeys),
          command.code,
          this.now(),
        );
        if (
          counter === null ||
          (user.mfaLastUsedCounter !== null && counter <= user.mfaLastUsedCounter)
        ) {
          await writeAudit(tx, 'AUTH_MFA_FAILED', 'staff', user.id, requestId, user.id);
          return false;
        }
        await tx.staffUser.update({
          where: { id: user.id },
          data: { mfaLastUsedCounter: counter },
        });
        const now = this.now();
        await tx.staffSession.update({
          where: { id: sessionId },
          data: {
            tokenHash: hashToken(replacement),
            authStage: 'AUTHENTICATED',
            mfaVerifiedAt: now,
            lastSeenAt: now,
            expiresAt: new Date(now.getTime() + 8 * 60 * MINUTE),
          },
        });
        await writeAudit(tx, 'AUTH_MFA_ACCEPTED', 'staff', user.id, requestId, user.id);
        return true;
      },
    );
    if (!outcome) throw new AccessError(401, 'INVALID_MFA');
    return { token: replacement };
  }

  me(raw: string | null, requestId: string) {
    return this.withSession(raw, { requestId, touch: false }, async (_tx, actor) => actor);
  }
  logout(raw: string | null, requestId: string) {
    return this.withSession(raw, { requestId, challenge: true }, async (tx, actor, sessionId) => {
      await tx.staffSession.update({ where: { id: sessionId }, data: { revokedAt: this.now() } });
      await writeAudit(tx, 'AUTH_LOGOUT', 'staff', actor.id, requestId, actor.id);
    });
  }
  async changePassword(raw: string | null, input: unknown, requestId: string) {
    const command = validated(passwordChangeSchema, input);
    const actor = await this.me(raw, requestId);
    await this.limiter.require('password-account', actor.id, 5, 15 * MINUTE);
    return this.withSession(raw, { requestId }, async (tx, actor) => {
      const user = await tx.staffUser.findUniqueOrThrow({ where: { id: actor.id } });
      if (!(await verifyPassword(user.passwordHash, command.currentPassword)))
        throw new AccessError(401, 'LOGIN_FAILED');
      await tx.staffUser.update({
        where: { id: user.id },
        data: {
          passwordHash: await hashPassword(command.newPassword),
          passwordChangedAt: this.now(),
        },
      });
      await writeAudit(tx, 'STAFF_PASSWORD_CHANGED', 'staff', user.id, requestId, user.id);
    });
  }

  async bootstrap(input: unknown) {
    const command = validated(credentialsSchema, input);
    const counter = totpCounter(command.mfaSecret, command.code, this.now());
    if (counter === null) throw new AccessError(400, 'INVALID_MFA');
    const passwordHash = await hashPassword(command.password);
    const id = randomUUID();
    return withTransaction(this.client, async (tx) => {
      await lockStaffManagement(tx);
      if (
        (await tx.bootstrapState.findUnique({ where: { id: true } })) ||
        (await tx.staffUser.count({ where: { role: 'ADMIN', isActive: true } }))
      )
        throw new AccessError(409, 'BOOTSTRAP_ALREADY_COMPLETED');
      await tx.staffUser.create({
        data: {
          id,
          email: command.email,
          passwordHash,
          role: 'ADMIN',
          isActive: true,
          mfaEnabled: true,
          mfaSecretCiphertext: sealMfa(
            command.mfaSecret,
            this.config.mfaWriteKey?.key ?? this.config.mfaKey,
            id,
            this.config.mfaWriteKey?.id,
          ),
          mfaLastUsedCounter: counter,
          passwordChangedAt: this.now(),
        },
      });
      await tx.bootstrapState.create({
        data: { id: true, adminUserId: id, completedAt: this.now() },
      });
      await writeAudit(tx, 'STAFF_BOOTSTRAPPED', 'staff', id, randomUUID(), id);
      return { id };
    });
  }

  // Private operator CLI only; deliberately not exposed through HTTP.
  async changeStaffEmail(input: unknown) {
    const command = validated(operatorEmailChangeSchema, input);
    if (command.email === command.newEmail) throw new AccessError(400, 'EMAIL_UNCHANGED');
    return withTransaction(this.client, async (tx) => {
      await lockStaffManagement(tx);
      const target = await tx.staffUser.findUnique({
        where: { email: command.email },
        select: { id: true },
      });
      if (!target) throw new AccessError(404, 'NOT_FOUND');
      await lockStaff(tx, [target.id]);
      if (
        await tx.staffUser.findUnique({ where: { email: command.newEmail }, select: { id: true } })
      )
        throw new AccessError(409, 'EMAIL_ALREADY_USED');
      await tx.staffUser.update({ where: { id: target.id }, data: { email: command.newEmail } });
      await tx.staffSession.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: this.now() },
      });
      await writeAudit(tx, 'STAFF_EMAIL_CHANGED', 'staff', target.id, randomUUID(), null, [
        'email',
      ]);
    });
  }

  async provisionCredentials(input: unknown) {
    const command = validated(credentialsSchema, input);
    const counter = totpCounter(command.mfaSecret, command.code, this.now());
    if (counter === null) throw new AccessError(400, 'INVALID_MFA');
    const passwordHash = await hashPassword(command.password);
    return withTransaction(this.client, async (tx) => {
      await lockStaffManagement(tx);
      if (!(await tx.bootstrapState.findUnique({ where: { id: true } })))
        throw new AccessError(409, 'BOOTSTRAP_REQUIRED');
      const target = await tx.staffUser.findUnique({
        where: { email: command.email },
        select: { id: true },
      });
      if (!target) throw new AccessError(404, 'NOT_FOUND');
      await lockStaff(tx, [target.id]);
      await tx.staffUser.update({
        where: { id: target.id },
        data: {
          passwordHash,
          isActive: true,
          mfaEnabled: true,
          mfaSecretCiphertext: sealMfa(
            command.mfaSecret,
            this.config.mfaWriteKey?.key ?? this.config.mfaKey,
            target.id,
            this.config.mfaWriteKey?.id,
          ),
          mfaLastUsedCounter: counter,
          passwordChangedAt: this.now(),
        },
      });
      await writeAudit(tx, 'STAFF_CREDENTIALS_PROVISIONED', 'staff', target.id, randomUUID(), null);
    });
  }
}
