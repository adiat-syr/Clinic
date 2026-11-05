import type { PrismaClient } from '../../generated/prisma/client.js';
import { AccessError } from './errors.js';
import { mac } from './crypto.js';

export class DatabaseRateLimiter {
  constructor(
    private readonly client: PrismaClient,
    private readonly key: Uint8Array,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async require(scope: string, identity: string, limit: number, periodMs: number) {
    const now = this.now();
    const resetsAt = new Date(now.getTime() + periodMs);
    const keyHash = mac(this.key, `rate:${scope}`, identity);
    const rows = await this.client.$queryRaw<{ attempts: number }[]>`
      INSERT INTO rate_limit_buckets (key_hash,attempts,resets_at) VALUES (${keyHash},1,${resetsAt})
      ON CONFLICT (key_hash) DO UPDATE SET
        attempts=CASE WHEN rate_limit_buckets.resets_at<=${now} THEN 1 ELSE LEAST(rate_limit_buckets.attempts+1,${limit + 1}) END,
        resets_at=CASE WHEN rate_limit_buckets.resets_at<=${now} THEN ${resetsAt} ELSE rate_limit_buckets.resets_at END
      RETURNING attempts`;
    if ((rows[0]?.attempts ?? limit + 1) > limit) throw new AccessError(429, 'RATE_LIMITED');
  }
}
