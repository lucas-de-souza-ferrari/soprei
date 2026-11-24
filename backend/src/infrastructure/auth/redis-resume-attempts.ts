import type { Redis } from 'ioredis';
import type { ResumeAttemptStore } from '../../application/ports/attendance-resume.js';
import { flushKey } from '../../application/ports/inbound-job-queue.js';
import { RESUME_ATTEMPT_WINDOW_MS, RESUME_MAX_ATTEMPTS } from '../../domain/index.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';

// KEYS[1] = contador do contato. ARGV = teto, TTL (s). No teto nada é incrementado (0); senão conta
// e devolve 1. Toda chave tem TTL (também a que, por algum acaso, nasceu sem).
const TAKE = `
if tonumber(redis.call('GET', KEYS[1]) or '0') >= tonumber(ARGV[1]) then return 0 end
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return 1
`;

/**
 * Contador de retomadas por contato (spec 035, D3). Chave `<prefixo>resume-attempts:<flushKey>`: o
 * `flushKey` leva o `companyId` e um hash do `contactRef`, nunca o telefone, e é a mesma identidade
 * que a fila já usa para o `flush` do contato. TTL de 24 h. Redis fora = `ServiceUnavailableError`,
 * sem anexar o erro do ioredis (que carrega `command.args`).
 */
export class RedisResumeAttemptStore implements ResumeAttemptStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  async take(companyId: string, contactRef: string): Promise<boolean> {
    const key = `${this.prefix}resume-attempts:${flushKey({ companyId, contactRef })}`;
    try {
      const result: unknown = await this.redis.eval(
        TAKE,
        1,
        key,
        RESUME_MAX_ATTEMPTS,
        Math.ceil(RESUME_ATTEMPT_WINDOW_MS / 1000),
      );
      return result === 1;
    } catch {
      throw new ServiceUnavailableError('Contador de retomadas indisponível');
    }
  }
}
