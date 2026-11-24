import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type {
  PlatformSession,
  PlatformSessionStore,
} from '../../application/ports/platform-session.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';

/** Segredo do cookie: 32 bytes em base64url, sem preenchimento. */
export const PLATFORM_SESSION_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const sessionSchema = z.object({
  id: z.uuid(),
  adminId: z.uuid(),
  factor: z.string().regex(/^[0-9a-f]{32}$/),
  createdAt: z.number(),
  expiresAt: z.number(),
});

// KEYS[1] = chave da sessão; ARGV[1] = prazo ocioso. Relógio do Redis; o teto absoluto vem na sessão.
const READ = `
local value = redis.call('GET', KEYS[1])
if not value then return nil end
local data = cjson.decode(value)
local time = redis.call('TIME')
local now = tonumber(time[1])
local ttl = math.min(tonumber(ARGV[1]), data.expiresAt - now)
if ttl <= 0 then redis.call('DEL', KEYS[1]); return nil end
redis.call('EXPIRE', KEYS[1], ttl)
return value
`;

// KEYS[1] = chave da sessão; ARGV = adminId, id da sessão, fator, teto absoluto, prazo ocioso.
const CREATE = `
local time = redis.call('TIME')
local now = tonumber(time[1])
local data = {adminId = ARGV[1], id = ARGV[2], factor = ARGV[3], createdAt = now, expiresAt = now + tonumber(ARGV[4])}
redis.call('SET', KEYS[1], cjson.encode(data), 'EX', math.min(tonumber(ARGV[5]), tonumber(ARGV[4])))
return 1
`;

/**
 * Sessões do admin da plataforma no Redis (spec 044, E1): `<prefixo>platform-session:<SHA-256 do
 * segredo>` (o prefixo já traz a versão, `v3:`). Toda chave tem TTL. Falha do Redis vira 503
 * (fail-closed) e o erro do ioredis nunca é repassado (carrega `command.args`, com a chave).
 */
export class RedisPlatformSessionStore implements PlatformSessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly idleSeconds: number,
    private readonly maxSeconds: number,
  ) {}

  private key(secret: string): string {
    return `${this.prefix}platform-session:${createHash('sha256').update(secret).digest('hex')}`;
  }

  async create(adminId: string, factor: string): Promise<string> {
    const secret = randomBytes(32).toString('base64url');
    try {
      await this.redis.eval(
        CREATE,
        1,
        this.key(secret),
        adminId,
        randomUUID(),
        factor,
        this.maxSeconds,
        this.idleSeconds,
      );
      return secret;
    } catch {
      throw new ServiceUnavailableError('Sessão indisponível');
    }
  }

  async read(secret: string): Promise<PlatformSession | null> {
    if (!PLATFORM_SESSION_SECRET_PATTERN.test(secret)) return null;
    let value: unknown;
    try {
      value = await this.redis.eval(READ, 1, this.key(secret), this.idleSeconds);
    } catch {
      throw new ServiceUnavailableError('Sessão indisponível');
    }
    if (value === null) return null;
    if (typeof value !== 'string') throw new ServiceUnavailableError('Sessão indisponível');
    let raw: unknown;
    try {
      raw = JSON.parse(value) as unknown;
    } catch {
      throw new ServiceUnavailableError('Sessão indisponível');
    }
    const parsed = sessionSchema.safeParse(raw);
    if (!parsed.success) throw new ServiceUnavailableError('Sessão indisponível');
    return { id: parsed.data.id, adminId: parsed.data.adminId, factor: parsed.data.factor };
  }

  async revoke(secret: string): Promise<void> {
    if (!PLATFORM_SESSION_SECRET_PATTERN.test(secret)) return;
    try {
      await this.redis.del(this.key(secret));
    } catch {
      throw new ServiceUnavailableError('Sessão indisponível');
    }
  }
}
