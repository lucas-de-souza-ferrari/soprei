import type { Redis } from 'ioredis';
import type { InvitationQuotaStore } from '../../application/ports/invitation-quota.js';
import {
  INVITATION_ACCOUNT_SENDS_PER_DAY,
  INVITATION_QUOTA_WINDOW_MS,
  INVITATION_RECIPIENT_EMAILS_PER_DAY,
} from '../../domain/index.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';

// KEYS[1] = cota do destinatário; KEYS[2] (opcional) = cota da conta convidadora.
// ARGV[1] = teto do destinatário, ARGV[2] = teto da conta, ARGV[3] = TTL em segundos.
// Tudo ou nada: se qualquer cota já está no teto, nada é incrementado e o script devolve 0.
// Toda chave tem TTL (também a que, por algum acaso, nasceu sem).
const TAKE = `
local function current(key)
  return tonumber(redis.call('GET', key) or '0')
end
if current(KEYS[1]) >= tonumber(ARGV[1]) then return 0 end
if KEYS[2] and current(KEYS[2]) >= tonumber(ARGV[2]) then return 0 end
for i = 1, #KEYS do
  local count = redis.call('INCR', KEYS[i])
  if count == 1 or redis.call('TTL', KEYS[i]) < 0 then
    redis.call('EXPIRE', KEYS[i], tonumber(ARGV[3]))
  end
end
return 1
`;

/**
 * Cotas do e-mail de convite entre empresas (spec 025). As chaves `<prefixo>invite-quota:<tipo>:<HMAC>`
 * nunca guardam e-mail nem id em claro. Redis fora = `ServiceUnavailableError` (fail-closed); o erro
 * do ioredis (que carrega `command.args`) nunca é anexado.
 */
export class RedisInvitationQuotaStore implements InvitationQuotaStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  async ping(): Promise<void> {
    try {
      await this.redis.ping();
    } catch {
      throw new ServiceUnavailableError('Cotas de convite indisponíveis');
    }
  }

  async take(recipientKey: string, accountKey: string | null): Promise<boolean> {
    const keys = [`${this.prefix}invite-quota:recipient:${recipientKey}`];
    if (accountKey !== null) keys.push(`${this.prefix}invite-quota:account:${accountKey}`);
    try {
      const result: unknown = await this.redis.eval(
        TAKE,
        keys.length,
        ...keys,
        INVITATION_RECIPIENT_EMAILS_PER_DAY,
        INVITATION_ACCOUNT_SENDS_PER_DAY,
        Math.ceil(INVITATION_QUOTA_WINDOW_MS / 1000),
      );
      return result === 1;
    } catch {
      throw new ServiceUnavailableError('Cotas de convite indisponíveis');
    }
  }
}
