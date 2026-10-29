import type { Result } from '../../shared/types/index.js';
import type { AuthIdentity } from '../auth/identity.js';

export interface IssuedAccessToken {
  readonly token: string;
  /** Validade em segundos (o `expiresIn` da resposta de login). */
  readonly expiresIn: number;
}

export type AccessTokenRejection = 'invalid' | 'expired';

export interface VerifiedAccessToken {
  readonly identity: AuthIdentity;
  /** `iat` do token, em segundos (compara com o `nbf` do usuário). */
  readonly issuedAt: number;
}

/**
 * Access token (JWT, spec 007). A implementação (`jose`) vive em `src/infrastructure/auth/` e o
 * ESLint impede importar a biblioteca de fora; a porta nunca expõe tipo dela.
 */
export interface AccessTokenService {
  issue(identity: AuthIdentity): Promise<IssuedAccessToken>;
  /** Nunca lança por token ruim: a categoria volta no `Result` (só vai à métrica). */
  verify(token: string): Promise<Result<VerifiedAccessToken, AccessTokenRejection>>;
}
