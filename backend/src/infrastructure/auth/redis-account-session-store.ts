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
  companyId: z.uuid().nullable(),
  createdAt: z.number(),
  expiresAt: z.number(),
  /** Geração da conta quando a sessão nasceu (spec 021); ausente nas sessões anteriores (= 0). */
  gen: z.number().optional(),
});

/** Teto absoluto da sessão (30 dias) e ociosidade (7 dias). */
const SESSION_MAX_SECONDS = 30 * 86400;
const SESSION_IDLE_SECONDS = 7 * 86400;
/** A geração vive um pouco mais que o teto absoluto, para nenhuma sessão antiga sobreviver a ela. */
const GENERATION_TTL_SECONDS = 31 * 86400;

// KEYS[1] = chave da sessão; ARGV[1] = TTL ocioso, ARGV[2] = companyId a selecionar ('' = nenhum),
// ARGV[3] = prefixo das chaves (para montar a chave da geração a partir de data.accountId).
// A geração atual maior que a gravada na sessão = sessão revogada em massa: apaga e responde ausente.
const READ = `
local value = redis.call('GET', KEYS[1])
if not value then return nil end
local data = cjson.decode(value)
local current = tonumber(redis.call('GET', ARGV[3] .. 'account-gen:' .. data.accountId)) or 0
if current > (tonumber(data.gen) or 0) then redis.call('DEL', KEYS[1]); return nil end
local time = redis.call('TIME')
local now = tonumber(time[1])
local ttl = math.min(tonumber(ARGV[1]), data.expiresAt - now)
if ttl <= 0 then redis.call('DEL', KEYS[1]); return nil end
if ARGV[2] ~= '' then data.companyId = ARGV[2]; value = cjson.encode(data) end
redis.call('SET', KEYS[1], value, 'EX', ttl)
return value
`;

// KEYS[1] = chave da sessão, KEYS[2] = chave da geração; ARGV = accountId, id da sessão, teto
// absoluto, TTL ocioso. Ler a geração e gravar a sessão no mesmo script resolve a corrida entre
// criar uma sessão e revogar em massa: ou a sessão nasce com a geração nova, ou com a antiga e a
// leitura seguinte a derruba.
const CREATE = `
local gen = tonumber(redis.call('GET', KEYS[2])) or 0
local time = redis.call('TIME')
local now = tonumber(time[1])
local data = {accountId = ARGV[1], id = ARGV[2], companyId = cjson.null, createdAt = now, expiresAt = now + tonumber(ARGV[3]), gen = gen}
redis.call('SET', KEYS[1], cjson.encode(data), 'EX', tonumber(ARGV[4]))
return 1
`;

const REVOKE_ALL = `
local value = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
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
  private generationKey(accountId: string): string {
    return `${this.prefix}account-gen:${accountId}`;
  }
  async create(accountId: string): Promise<string> {
    const secret = randomBytes(32).toString('base64url');
    try {
      await this.redis.eval(
        CREATE,
        2,
        this.key(secret),
        this.generationKey(accountId),
        accountId,
        randomUUID(),
        SESSION_MAX_SECONDS,
        SESSION_IDLE_SECONDS,
      );
      return secret;
    } catch {
      throw new ServiceUnavailableError('Sessão indisponível');
    }
  }
  async read(secret: string): Promise<AccountSession | null> {
    const key = this.key(secret);
    try {
      const value: unknown = await this.redis.eval(
        READ,
        1,
        key,
        SESSION_IDLE_SECONDS,
        '',
        this.prefix,
      );
      if (value === null) return null;
      if (typeof value !== 'string') throw new ServiceUnavailableError('Sessão indisponível');
      const parsed = sessionSchema.safeParse(JSON.parse(value) as unknown);
      if (!parsed.success) throw new ServiceUnavailableError('Sessão indisponível');
      return parsed.data;
    } catch {
      throw new ServiceUnavailableError('Sessão indisponível');
    }
  }
  async select(secret: string, companyId: string): Promise<void> {
    const key = this.key(secret);
    let result: unknown;
    try {
      result = await this.redis.eval(READ, 1, key, SESSION_IDLE_SECONDS, companyId, this.prefix);
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
  async revokeAll(accountId: string): Promise<void> {
    try {
      await this.redis.eval(REVOKE_ALL, 1, this.generationKey(accountId), GENERATION_TTL_SECONDS);
    } catch {
      throw new ServiceUnavailableError('Sessão indisponível');
    }
  }
}
