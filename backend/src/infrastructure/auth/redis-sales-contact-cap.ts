import type { Redis } from 'ioredis';
import type { SalesContactDailyCap } from '../../application/ports/sales-contact.js';
import { SALES_CONTACT_CAP_TTL_SECONDS, SALES_CONTACT_DAILY_CAP } from '../../domain/index.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';

// KEYS[1] = contador do dia; ARGV[1] = TTL em segundos. INCR e, na primeira vez (ou se a chave perdeu o TTL
// por algum acaso), EXPIRE: toda chave tem TTL.
const TAKE = `
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return count
`;

/**
 * Teto global diário do contato comercial (spec 040, D13): `<prefixo>sales-contact:day:<AAAA-MM-DD UTC>`, com
 * TTL de 48 h. A chave não tem dado de ninguém. Redis fora = `ServiceUnavailableError` (fail-closed); o erro do
 * ioredis (que carrega `command.args`) nunca é anexado.
 */
export class RedisSalesContactCap implements SalesContactDailyCap {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly cap: number = SALES_CONTACT_DAILY_CAP,
  ) {}

  async take(day: string): Promise<boolean> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError('dia inválido');
    try {
      const count: unknown = await this.redis.eval(
        TAKE,
        1,
        `${this.prefix}sales-contact:day:${day}`,
        SALES_CONTACT_CAP_TTL_SECONDS,
      );
      return typeof count === 'number' && count <= this.cap;
    } catch {
      throw new ServiceUnavailableError('Contato comercial indisponível');
    }
  }
}
