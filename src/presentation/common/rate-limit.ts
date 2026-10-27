import type { RateLimitProfile } from '../../shared/rate-limit/profiles.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Perfil de rate limiting da rota (spec 005). Sem ele a rota usa `public`. Toda rota nova
     * declara o perfil certo; para uma rota de infraestrutura sem limite, `config: { rateLimit: false }`
     * (ver `NO_RATE_LIMIT`).
     */
    rateLimitProfile?: RateLimitProfile;
  }
}

/** Opt-out do plugin: só para `/health`, `/health/ready` e `/metrics`. */
export const NO_RATE_LIMIT = { rateLimit: false } as const;

/**
 * `config` de rota que escolhe um perfil: `app.get(path, { config: rateLimitProfile('admin') }, ...)`.
 *
 * O limite de uma rota vem SÓ do perfil (os números ficam na config). Não declare
 * `config.rateLimit` como objeto (`{ max, timeWindow }` do plugin): o limiter é um hook da raiz e
 * ignora o limite por rota, então ele não teria efeito algum; o teste de inventário de rotas falha
 * se alguma rota fizer isso. Só `rateLimit: false` (`NO_RATE_LIMIT`) é válido, e apenas para
 * infraestrutura.
 */
export function rateLimitProfile(profile: RateLimitProfile): {
  readonly rateLimitProfile: RateLimitProfile;
} {
  return { rateLimitProfile: profile };
}
