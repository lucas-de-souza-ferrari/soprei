import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { PLATFORM_SCOPE } from '../../application/auth/identity.js';
import type {
  AccessCheck,
  LoginLock,
  RotateOutcome,
  SessionStore,
} from '../../application/ports/session-store.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import { isUuid } from '../../shared/utils/index.js';
import { describeRedisError } from '../cache/rate-limit-redis.js';

/** Quantos hashes já usados cada sessão lembra (para detectar reuso). */
export const USED_HASHES_KEPT = 50;

export interface RedisSessionStoreOptions {
  readonly client: Redis;
  readonly logger: FastifyBaseLogger;
  /** `AUTH_REDIS_PREFIX`, ex.: `soprei:auth:`. Os testes passam um prefixo único. */
  readonly prefix: string;
  /** Prazo ocioso da sessão, renovado a cada rotação (`AUTH_REFRESH_TTL_SECONDS`). */
  readonly idleTtlSeconds: number;
  /** Teto absoluto desde o login (`AUTH_SESSION_MAX_SECONDS`). */
  readonly maxSeconds: number;
  /** Validade do access token: é o TTL das marcas de revogação (`AUTH_ACCESS_TTL_SECONDS`). */
  readonly accessTtlSeconds: number;
  readonly loginMaxFailures: number;
  readonly loginLockSeconds: number;
  /** Relógio do processo (só para o `nbf`, que se compara com o `iat` do token). */
  readonly now?: () => Date;
}

// Toda chave criada aqui tem TTL, e o relógio que decide os prazos é o do Redis (`TIME`).
//
// create: KEYS = sess, used, usess; ARGV = userId, refreshHash, idleTtl, maxSeconds, sessionId.
const CREATE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1])
local maxSeconds = tonumber(ARGV[4])
local ttl = math.min(tonumber(ARGV[3]), maxSeconds)
redis.call('DEL', KEYS[1], KEYS[2])
redis.call('HSET', KEYS[1], 'userId', ARGV[1], 'current', ARGV[2], 'maxAt', now + maxSeconds)
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('SADD', KEYS[3], ARGV[5])
redis.call('EXPIRE', KEYS[3], maxSeconds)
return 1
`;

// rotate: KEYS = sess, used, rsid; ARGV = presentedHash, newHash, idleTtl, accessTtl, usedKept.
// Retorna {0} (inválido), {1, userId} (rotacionou) ou {2, userId} (reuso: sessão revogada).
const ROTATE_SCRIPT = `
local current = redis.call('HGET', KEYS[1], 'current')
if not current then return {0} end
if redis.call('HGET', KEYS[1], 'revoked') == '1' then return {0} end
local userId = redis.call('HGET', KEYS[1], 'userId')
if ARGV[1] == current then
  local t = redis.call('TIME')
  local maxAt = tonumber(redis.call('HGET', KEYS[1], 'maxAt'))
  local ttl = math.min(tonumber(ARGV[3]), maxAt - tonumber(t[1]))
  if ttl <= 0 then return {0} end
  redis.call('LPUSH', KEYS[2], current)
  redis.call('LTRIM', KEYS[2], 0, tonumber(ARGV[5]) - 1)
  redis.call('HSET', KEYS[1], 'current', ARGV[2])
  redis.call('EXPIRE', KEYS[1], ttl)
  redis.call('EXPIRE', KEYS[2], ttl)
  return {1, userId}
end
local used = redis.call('LRANGE', KEYS[2], 0, -1)
for _, hash in ipairs(used) do
  if hash == ARGV[1] then
    redis.call('HSET', KEYS[1], 'revoked', '1')
    redis.call('SET', KEYS[3], '1', 'EX', tonumber(ARGV[4]))
    return {2, userId}
  end
end
return {0}
`;

// revokeByRefresh: KEYS = sess, used, rsid; ARGV = presentedHash, accessTtl. 1 se revogou.
const REVOKE_BY_REFRESH_SCRIPT = `
local current = redis.call('HGET', KEYS[1], 'current')
if not current then return 0 end
local known = (ARGV[1] == current)
if not known then
  for _, hash in ipairs(redis.call('LRANGE', KEYS[2], 0, -1)) do
    if hash == ARGV[1] then known = true break end
  end
end
if not known then return 0 end
redis.call('HSET', KEYS[1], 'revoked', '1')
redis.call('SET', KEYS[3], '1', 'EX', tonumber(ARGV[2]))
return 1
`;

// revokeSession: KEYS = sess, rsid; ARGV = accessTtl.
const REVOKE_SESSION_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('HSET', KEYS[1], 'revoked', '1') end
redis.call('SET', KEYS[2], '1', 'EX', tonumber(ARGV[1]))
return 1
`;

// revokeAll: KEYS = usess, nbf; ARGV = scopePrefix (<prefix><escopo>:), accessTtl, nowSeconds.
// As chaves de cada sessão do conjunto são montadas aqui dentro com o prefixo do mesmo escopo.
const REVOKE_ALL_SCRIPT = `
for _, sid in ipairs(redis.call('SMEMBERS', KEYS[1])) do
  local sess = ARGV[1] .. 'sess:' .. sid
  if redis.call('EXISTS', sess) == 1 then redis.call('HSET', sess, 'revoked', '1') end
  redis.call('SET', ARGV[1] .. 'rsid:' .. sid, '1', 'EX', tonumber(ARGV[2]))
end
redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[2], ARGV[3], 'EX', tonumber(ARGV[2]))
return 1
`;

// loginFailure: KEYS = key; ARGV = lockSeconds. Sempre com TTL.
const LOGIN_FAILURE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return count
`;

// loginState: KEYS = key. Retorna {falhas, pttl}.
const LOGIN_STATE_SCRIPT = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
return {count, redis.call('PTTL', KEYS[1])}
`;

interface AuthCommands {
  authCreate(...args: string[]): Promise<unknown>;
  authRotate(...args: string[]): Promise<unknown>;
  authRevokeByRefresh(...args: string[]): Promise<unknown>;
  authRevokeSession(...args: string[]): Promise<unknown>;
  authRevokeAll(...args: string[]): Promise<unknown>;
  authLoginFailure(...args: string[]): Promise<unknown>;
  authLoginState(...args: string[]): Promise<unknown>;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function assertScope(scope: string): void {
  if (scope !== PLATFORM_SCOPE && !isUuid(scope)) throw new RangeError('escopo de sessão inválido');
}

function assertId(value: string): void {
  if (!isUuid(value)) throw new RangeError('identificador de sessão inválido');
}

function assertHash(value: string): void {
  if (!SHA256_HEX.test(value)) throw new RangeError('hash inválido');
}

/**
 * Sessões no Redis (spec 007). Toda chave começa por `<prefixo><ClientId|platform>:` (as de
 * usuário derivam do `ClientId`, as de administrador de `platform`); a única exceção declarada é o
 * contador de falhas de login (`<prefixo>login-fail:<hash>`), que vale antes de existir `ClientId`.
 * Só o **hash** do segredo do refresh fica no Redis. Toda falha vira `ServiceUnavailableError`
 * (fail-closed), logada só por `describeRedisError` (o erro do ioredis carrega `command.args`).
 */
export class RedisSessionStore implements SessionStore {
  private readonly redis: Redis;
  private readonly commands: AuthCommands;
  private readonly logger: FastifyBaseLogger;
  private readonly prefix: string;
  private readonly options: RedisSessionStoreOptions;

  constructor(options: RedisSessionStoreOptions) {
    this.options = options;
    this.redis = options.client;
    this.logger = options.logger;
    this.prefix = options.prefix;
    const define = (name: keyof AuthCommands, numberOfKeys: number, lua: string): void => {
      this.redis.defineCommand(name, { numberOfKeys, lua });
    };
    define('authCreate', 3, CREATE_SCRIPT);
    define('authRotate', 3, ROTATE_SCRIPT);
    define('authRevokeByRefresh', 3, REVOKE_BY_REFRESH_SCRIPT);
    define('authRevokeSession', 2, REVOKE_SESSION_SCRIPT);
    define('authRevokeAll', 2, REVOKE_ALL_SCRIPT);
    define('authLoginFailure', 1, LOGIN_FAILURE_SCRIPT);
    define('authLoginState', 1, LOGIN_STATE_SCRIPT);
    this.commands = this.redis as unknown as AuthCommands;
  }

  private key(scope: string, kind: string, id: string): string {
    return `${this.prefix}${scope}:${kind}:${id}`;
  }

  private nowSeconds(): number {
    return Math.floor((this.options.now ?? (() => new Date()))().getTime() / 1000);
  }

  /** Falha de Redis vira 503. Nunca anexa o erro do ioredis (carrega `command.args`). */
  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RangeError) throw error;
      this.logger.error(describeRedisError(error), 'falha no Redis de autenticação (fail-closed)');
      throw new ServiceUnavailableError('Serviço de autenticação indisponível', {
        context: { dependency: 'redis' },
      });
    }
  }

  async createSession(input: {
    scope: string;
    sessionId: string;
    subjectId: string;
    refreshHash: string;
  }): Promise<void> {
    const { scope, sessionId, subjectId, refreshHash } = input;
    assertScope(scope);
    assertId(sessionId);
    assertId(subjectId);
    assertHash(refreshHash);
    await this.guard(() =>
      this.commands.authCreate(
        this.key(scope, 'sess', sessionId),
        this.key(scope, 'used', sessionId),
        this.key(scope, 'usess', subjectId),
        subjectId,
        refreshHash,
        String(this.options.idleTtlSeconds),
        String(this.options.maxSeconds),
        sessionId,
      ),
    );
  }

  async rotate(input: {
    scope: string;
    sessionId: string;
    presentedHash: string;
    newHash: string;
  }): Promise<RotateOutcome> {
    const { scope, sessionId, presentedHash, newHash } = input;
    assertScope(scope);
    assertId(sessionId);
    assertHash(presentedHash);
    assertHash(newHash);
    const reply = await this.guard(() =>
      this.commands.authRotate(
        this.key(scope, 'sess', sessionId),
        this.key(scope, 'used', sessionId),
        this.key(scope, 'rsid', sessionId),
        presentedHash,
        newHash,
        String(this.options.idleTtlSeconds),
        String(this.options.accessTtlSeconds),
        String(USED_HASHES_KEPT),
      ),
    );
    if (!Array.isArray(reply)) return { status: 'invalid' };
    const [code, subjectId] = reply as [unknown, unknown];
    if ((code === 1 || code === 2) && typeof subjectId === 'string') {
      return { status: code === 1 ? 'rotated' : 'reuse', subjectId };
    }
    return { status: 'invalid' };
  }

  async revokeByRefresh(input: {
    scope: string;
    sessionId: string;
    presentedHash: string;
  }): Promise<boolean> {
    const { scope, sessionId, presentedHash } = input;
    assertScope(scope);
    assertId(sessionId);
    assertHash(presentedHash);
    const reply = await this.guard(() =>
      this.commands.authRevokeByRefresh(
        this.key(scope, 'sess', sessionId),
        this.key(scope, 'used', sessionId),
        this.key(scope, 'rsid', sessionId),
        presentedHash,
        String(this.options.accessTtlSeconds),
      ),
    );
    return reply === 1;
  }

  async revokeSession(scope: string, sessionId: string): Promise<void> {
    assertScope(scope);
    assertId(sessionId);
    await this.guard(() =>
      this.commands.authRevokeSession(
        this.key(scope, 'sess', sessionId),
        this.key(scope, 'rsid', sessionId),
        String(this.options.accessTtlSeconds),
      ),
    );
  }

  async revokeAllSessions(scope: string, subjectId: string): Promise<void> {
    assertScope(scope);
    assertId(subjectId);
    await this.guard(() =>
      this.commands.authRevokeAll(
        this.key(scope, 'usess', subjectId),
        this.key(scope, 'nbf', subjectId),
        `${this.prefix}${scope}:`,
        String(this.options.accessTtlSeconds),
        String(this.nowSeconds()),
      ),
    );
  }

  async checkAccess(input: {
    scope: string;
    sessionId: string;
    subjectId: string;
    issuedAt: number;
  }): Promise<AccessCheck> {
    const { scope, sessionId, subjectId, issuedAt } = input;
    assertScope(scope);
    assertId(sessionId);
    assertId(subjectId);
    const [revoked, notBefore] = await this.guard(() =>
      this.redis.mget(this.key(scope, 'rsid', sessionId), this.key(scope, 'nbf', subjectId)),
    );
    if (revoked !== null) return 'revoked';
    if (notBefore !== null && issuedAt < Number(notBefore)) return 'revoked';
    return 'ok';
  }

  async loginLockState(key: string): Promise<LoginLock> {
    assertHash(key);
    const reply = await this.guard(() => this.commands.authLoginState(this.failureKey(key)));
    if (!Array.isArray(reply)) return { locked: false };
    const [count, pttl] = reply as [unknown, unknown];
    if (typeof count !== 'number' || count < this.options.loginMaxFailures) {
      return { locked: false };
    }
    const seconds = typeof pttl === 'number' && pttl > 0 ? Math.ceil(pttl / 1000) : 1;
    return { locked: true, retryAfterSeconds: Math.max(1, seconds) };
  }

  async recordLoginFailure(key: string): Promise<void> {
    assertHash(key);
    await this.guard(() =>
      this.commands.authLoginFailure(this.failureKey(key), String(this.options.loginLockSeconds)),
    );
  }

  async resetLoginFailures(key: string): Promise<void> {
    assertHash(key);
    await this.guard(() => this.redis.del(this.failureKey(key)));
  }

  private failureKey(hash: string): string {
    return `${this.prefix}login-fail:${hash}`;
  }
}
