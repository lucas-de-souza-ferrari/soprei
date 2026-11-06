import type { Redis } from 'ioredis';
import type { ScheduleAiQuotaStore } from '../../application/ports/contact-scheduling.js';
import {
  type CompanyId,
  SCHEDULE_AI_COMPANY_MAX_WRITES_PER_DAY,
  SCHEDULE_AI_CONTACT_MAX_WRITES_PER_DAY,
  SCHEDULE_AI_QUOTA_WINDOW_MS,
} from '../../domain/index.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';

// KEYS[1] = cota do contato; KEYS[2] = cota da empresa. ARGV = teto do contato, teto da empresa, TTL (s).
// Tudo ou nada: se qualquer cota já está no teto, nada é incrementado (1 = ok, 2 = contato, 3 = empresa).
// Toda chave tem TTL (também a que, por algum acaso, nasceu sem).
const TAKE = `
local function current(key)
  return tonumber(redis.call('GET', key) or '0')
end
if current(KEYS[1]) >= tonumber(ARGV[1]) then return 2 end
if current(KEYS[2]) >= tonumber(ARGV[2]) then return 3 end
for i = 1, 2 do
  local count = redis.call('INCR', KEYS[i])
  if count == 1 or redis.call('TTL', KEYS[i]) < 0 then
    redis.call('EXPIRE', KEYS[i], tonumber(ARGV[3]))
  end
end
return 1
`;

/**
 * Cotas de escrita da IA na agenda (spec 028, decisão 6). Chaves `<prefixo>sched-ai-quota:contact:<HMAC>` e
 * `...:company:<companyId>` (nunca o `contactRef` em claro), com TTL de 24 h. Redis fora = `ping` falha e `take`
 * lança `ServiceUnavailableError`; o erro do ioredis (que carrega `command.args`) nunca é anexado.
 */
export class RedisScheduleAiQuotaStore implements ScheduleAiQuotaStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  async ping(): Promise<void> {
    try {
      await this.redis.ping();
    } catch {
      throw new ServiceUnavailableError('Cotas da agenda indisponíveis');
    }
  }

  async check(
    companyId: CompanyId,
    contactKey: string,
  ): Promise<'ok' | 'contact_limit' | 'company_limit'> {
    try {
      const [contact, company] = await this.redis.mget(
        `${this.prefix}sched-ai-quota:contact:${contactKey}`,
        `${this.prefix}sched-ai-quota:company:${companyId}`,
      );
      if (Number(contact ?? 0) >= SCHEDULE_AI_CONTACT_MAX_WRITES_PER_DAY) return 'contact_limit';
      if (Number(company ?? 0) >= SCHEDULE_AI_COMPANY_MAX_WRITES_PER_DAY) return 'company_limit';
      return 'ok';
    } catch {
      throw new ServiceUnavailableError('Cotas da agenda indisponíveis');
    }
  }

  async take(
    companyId: CompanyId,
    contactKey: string,
  ): Promise<'ok' | 'contact_limit' | 'company_limit'> {
    const keys = [
      `${this.prefix}sched-ai-quota:contact:${contactKey}`,
      `${this.prefix}sched-ai-quota:company:${companyId}`,
    ];
    try {
      const result: unknown = await this.redis.eval(
        TAKE,
        keys.length,
        ...keys,
        SCHEDULE_AI_CONTACT_MAX_WRITES_PER_DAY,
        SCHEDULE_AI_COMPANY_MAX_WRITES_PER_DAY,
        Math.ceil(SCHEDULE_AI_QUOTA_WINDOW_MS / 1000),
      );
      if (result === 1) return 'ok';
      return result === 3 ? 'company_limit' : 'contact_limit';
    } catch {
      throw new ServiceUnavailableError('Cotas da agenda indisponíveis');
    }
  }
}
