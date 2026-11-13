/**
 * Perfis de rate limiting (spec 005). Conjunto fixo e pequeno: o nome vira label de métrica
 * (`rate_limit_rejected_total{profile}`) e parte da chave no Redis, então nunca é dado do
 * usuário. Os números de cada perfil vivem na config, não aqui.
 *
 * - `public`: rede de segurança. Toda rota sem perfil cai aqui.
 * - `admin`: rotas `/admin/*`.
 * - `webhook`: webhook do canal de mensagens (declarado pela spec 011).
 * - `login`: `/auth/login` e `/auth/platform/login` (spec 007). **Fail-closed**: Redis fora = 503.
 * - `refresh`: `/auth/refresh` e `/auth/logout` (spec 007). **Fail-closed**.
 * - `contact`: `POST /contact/sales`, o formulário de contato comercial (spec 040). **Fail-closed**: sem o
 *   limiter, nada impediria um robô de fazer o SMTP do Soprei mandar e-mails em rajada.
 */
export const RATE_LIMIT_PROFILES = [
  'public',
  'admin',
  'webhook',
  'login',
  'refresh',
  'contact',
] as const;

export type RateLimitProfile = (typeof RATE_LIMIT_PROFILES)[number];

export const DEFAULT_RATE_LIMIT_PROFILE: RateLimitProfile = 'public';

export function isRateLimitProfile(value: unknown): value is RateLimitProfile {
  return (RATE_LIMIT_PROFILES as readonly unknown[]).includes(value);
}

/**
 * Perfis em que o Redis do limiter fora **bloqueia** a rota (503) em vez de liberá-la: com o
 * limiter fora, nada impediria força bruta de senha ou de refresh. Os demais seguem fail-open.
 */
export const FAIL_CLOSED_RATE_LIMIT_PROFILES: readonly RateLimitProfile[] = [
  'login',
  'refresh',
  'contact',
];
