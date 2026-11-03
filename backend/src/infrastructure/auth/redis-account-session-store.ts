import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type {
  AccountSession,
  AccountSessionStore,
} from '../../application/ports/account-session.js';
import { ServiceUnavailableError, UnauthorizedError } from '../../shared/errors/index.js';

const sessionSchema = z.object({
  accountId: z.uuid(),
  id: z.uuid(),
  clientId: z.uuid().nullable(),
  createdAt: z.number(),
  expiresAt: z.number(),
});
const READ = `
local value = redis.call('GET', KEYS[1])
if not value then return nil end
local data = cjson.decode(value)
local time = redis.call('TIME')
local now = tonumber(time[1])
local ttl = math.min(tonumber(ARGV[1]), data.expiresAt - now)
if ttl <= 0 then redis.call('DEL', KEYS[1]); return nil end
if ARGV[2] ~= '' then data.clientId = ARGV[2]; value = cjson.encode(data) end
redis.call('SET', KEYS[1], value, 'EX', ttl)
return value
`;

export class RedisAccountSessionStore implements AccountSessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}
  private key(secret: string): string {
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new UnauthorizedError();
    return `${this.prefix}account-session:${createHash('sha256').update(secret).digest('hex')}`;
  }
  async create(accountId: string): Promise<string> {
    const secret = randomBytes(32).toString('base64url');
    try {
      const [seconds] = await this.redis.time();
      const now = Number(seconds);
      await this.redis.set(
        this.key(secret),
        JSON.stringify({
          accountId,
          id: randomUUID(),
          clientId: null,
          createdAt: now,
          expiresAt: now + 30 * 86400,
        }),
        'EX',
        7 * 86400,
      );
      return secret;
    } catch {
      throw new ServiceUnavailableError('Sessão indisponível');
    }
  }
  async read(secret: string): Promise<AccountSession | null> {
    const key = this.key(secret);
    try {
      const value: unknown = await this.redis.eval(READ, 1, key, 7 * 86400, '');
      if (value === null) return null;
      if (typeof value !== 'string') throw new ServiceUnavailableError('Sessão indisponível');
      const parsed = sessionSchema.safeParse(JSON.parse(value) as unknown);
      if (!parsed.success) throw new ServiceUnavailableError('Sessão indisponível');
      return parsed.data;
    } catch {
      throw new ServiceUnavailableError('Sessão indisponível');
    }
  }
  async select(secret: string, clientId: string): Promise<void> {
    const key = this.key(secret);
    let result: unknown;
    try {
      result = await this.redis.eval(READ, 1, key, 7 * 86400, clientId);
    } catch {
      throw new ServiceUnavailableError('Sessão indisponível');
    }
    if (result === null) throw new UnauthorizedError();
  }
  async revoke(secret: string): Promise<void> {
    const key = this.key(secret);
    try {
      await this.redis.del(key);
    } catch {
      throw new ServiceUnavailableError('Sessão indisponível');
    }
  }
}
