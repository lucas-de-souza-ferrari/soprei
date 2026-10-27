import type { RateLimitProfile } from '../shared/rate-limit/profiles.js';

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

/** `config` de rota que escolhe um perfil: `app.get(path, { config: rateLimitProfile('admin') }, ...)`. */
export function rateLimitProfile(profile: RateLimitProfile): {
  readonly rateLimitProfile: RateLimitProfile;
} {
  return { rateLimitProfile: profile };
}
