/**
 * Hash de senha (spec 007). A implementação (scrypt) vive em `src/infrastructure/auth/`.
 * `verify` nunca lança por hash malformado: devolve `false`.
 */
export type HashLane = 'auth' | 'admin';

export interface HashOptions {
  /**
   * Fila de espera do pedido (spec 008). `auth` (padrão): login e refresh. `admin`: hashes pagos por
   * rotas de administração (criar usuário, redefinir e trocar senha), que têm um teto de espera
   * menor e separado, para não esgotar as vagas do login de todos as empresas.
   */
  readonly lane?: HashLane;
}

export interface PasswordHasher {
  /** Hash autodescritivo (`scrypt$N$r$p$<sal>$<hash>`), com sal aleatório. */
  hash(password: string, options?: HashOptions): Promise<string>;
  verify(password: string, storedHash: string, options?: HashOptions): Promise<boolean>;
  /**
   * Hash fictício, com os mesmos parâmetros do `hash`, para o login comparar contra ele quando a
   * conta não existe (mesmo trabalho em todos os caminhos: sem enumeração de contas).
   */
  dummyHash(): Promise<string>;
}
