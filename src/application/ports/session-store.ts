/**
 * Sessões (refresh tokens com rotação), revogação de access tokens e contador de falhas de login
 * (spec 007). Implementação no Redis em `src/infrastructure/auth/`. **Toda falha da dependência
 * vira `ServiceUnavailableError`** (fail-closed): nada é aceito nem emitido sem o store.
 *
 * `scope` é o `ClientId` (usuários) ou `platform`; `subjectId` é o id do usuário ou do admin. O
 * store só guarda o **hash** do segredo do refresh.
 */
export type RotateOutcome =
  | { readonly status: 'rotated'; readonly subjectId: string }
  /** O hash apresentado já foi usado: a sessão foi revogada. */
  | { readonly status: 'reuse'; readonly subjectId: string }
  /** Sessão inexistente, revogada ou segredo desconhecido (sem efeito sobre a sessão). */
  | { readonly status: 'invalid' };

export type AccessCheck = 'ok' | 'revoked';

export type LoginLock =
  { readonly locked: false } | { readonly locked: true; readonly retryAfterSeconds: number };

export interface SessionStore {
  createSession(input: {
    readonly scope: string;
    readonly sessionId: string;
    readonly subjectId: string;
    readonly refreshHash: string;
  }): Promise<void>;
  /** Rotação atômica com detecção de reuso. */
  rotate(input: {
    readonly scope: string;
    readonly sessionId: string;
    readonly presentedHash: string;
    readonly newHash: string;
  }): Promise<RotateOutcome>;
  /** Revoga a sessão se o hash é o vigente ou um já usado (o refresh é a credencial). */
  revokeByRefresh(input: {
    readonly scope: string;
    readonly sessionId: string;
    readonly presentedHash: string;
  }): Promise<boolean>;
  revokeSession(scope: string, sessionId: string): Promise<void>;
  /** Revoga todas as sessões do sujeito e corta os access tokens dele (`nbf`). */
  revokeAllSessions(scope: string, subjectId: string): Promise<void>;
  /** Consulta a revogação de um access token ainda dentro do prazo. */
  checkAccess(input: {
    readonly scope: string;
    readonly sessionId: string;
    readonly subjectId: string;
    readonly issuedAt: number;
  }): Promise<AccessCheck>;
  /** `key` é o identificador opaco da identidade do pedido (hash); ver `AuthService`. */
  loginLockState(key: string): Promise<LoginLock>;
  recordLoginFailure(key: string): Promise<void>;
  resetLoginFailures(key: string): Promise<void>;
}
