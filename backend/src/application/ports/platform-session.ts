/**
 * Sessão do admin da plataforma pelo cookie (spec 044, E1). O segredo vai só no cookie; o armazenamento
 * guarda o hash dele. Prazo ocioso renovado a cada leitura e teto absoluto desde a entrada.
 */
export interface PlatformSession {
  readonly id: string;
  readonly adminId: string;
  /** Impressão digital do segundo fator cadastrado quando a sessão nasceu (`factorFingerprint`). */
  readonly factor: string;
}

export interface PlatformSessionStore {
  /** Cria a sessão e devolve o segredo (256 bits, base64url), entregue uma vez. Indisponível: 503. */
  create(adminId: string, factor: string): Promise<string>;
  /** A sessão (renovando o prazo ocioso) ou `null` (vencida, revogada ou segredo malformado). Indisponível: 503. */
  read(secret: string): Promise<PlatformSession | null>;
  /** Apaga a sessão; idempotente. Indisponível: 503. */
  revoke(secret: string): Promise<void>;
}
