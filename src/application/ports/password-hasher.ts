/**
 * Hash de senha (spec 007). A implementação (scrypt) vive em `src/infrastructure/auth/`.
 * `verify` nunca lança por hash malformado: devolve `false`.
 */
export interface PasswordHasher {
  /** Hash autodescritivo (`scrypt$N$r$p$<sal>$<hash>`), com sal aleatório. */
  hash(password: string): Promise<string>;
  verify(password: string, storedHash: string): Promise<boolean>;
  /**
   * Hash fictício, com os mesmos parâmetros do `hash`, para o login comparar contra ele quando a
   * conta não existe (mesmo trabalho em todos os caminhos: sem enumeração de contas).
   */
  dummyHash(): Promise<string>;
}
