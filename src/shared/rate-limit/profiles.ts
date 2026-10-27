/**
 * Perfis de rate limiting (spec 005). Conjunto fixo e pequeno: o nome vira label de métrica
 * (`rate_limit_rejected_total{profile}`) e parte da chave no Redis, então nunca é dado do
 * usuário. Os números de cada perfil vivem na config, não aqui.
 *
 * - `public`: rede de segurança. Toda rota sem perfil cai aqui.
 * - `admin`: rotas `/admin/*`.
 * - `webhook`: webhook do canal de mensagens (declarado pela spec 011).
 */
export const RATE_LIMIT_PROFILES = ['public', 'admin', 'webhook'] as const;

export type RateLimitProfile = (typeof RATE_LIMIT_PROFILES)[number];

export const DEFAULT_RATE_LIMIT_PROFILE: RateLimitProfile = 'public';

export function isRateLimitProfile(value: unknown): value is RateLimitProfile {
  return (RATE_LIMIT_PROFILES as readonly unknown[]).includes(value);
}
