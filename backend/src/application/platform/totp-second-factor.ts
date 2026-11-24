import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { PlatformAdminId, PlatformAdminRepository } from '../../domain/index.js';
import { CredentialDecryptionError } from '../../shared/errors/index.js';
import type { PlatformSecretCipher } from '../ports/platform-secret-cipher.js';
import { base32Decode, matchTotp } from './totp.js';

/** Segundo fator do administrador da plataforma (spec 044, E1). */
export interface PlatformSecondFactor {
  /**
   * `true` só se há fator cadastrado, o código confere (passo atual ou vizinho) e o passo ainda não foi
   * usado. Nunca lança por código errado; só por falha de banco.
   */
  verify(
    adminId: PlatformAdminId,
    ciphertext: string | null,
    code: string | undefined,
  ): Promise<boolean>;
}

/**
 * Impressão digital do fator cadastrado, guardada na sessão do cookie: recadastrar o fator (ou apagá-lo
 * com a redefinição de senha) derruba as sessões abertas antes. É só um hash do texto cifrado (que tem
 * IV aleatório), nunca do segredo.
 */
export function factorFingerprint(ciphertext: string): string {
  return createHash('sha256').update(ciphertext).digest('hex').slice(0, 32);
}

export class TotpSecondFactor implements PlatformSecondFactor {
  private readonly cipher: PlatformSecretCipher;
  private readonly admins: Pick<PlatformAdminRepository, 'claimTotpStep'>;
  private readonly logger: FastifyBaseLogger;
  private readonly now: () => number;

  constructor(deps: {
    readonly cipher: PlatformSecretCipher;
    readonly admins: Pick<PlatformAdminRepository, 'claimTotpStep'>;
    readonly logger: FastifyBaseLogger;
    /** Relógio do servidor (milissegundos); injetável nos testes. Nunca o do navegador. */
    readonly now?: () => number;
  }) {
    this.cipher = deps.cipher;
    this.admins = deps.admins;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;
  }

  async verify(
    adminId: PlatformAdminId,
    ciphertext: string | null,
    code: string | undefined,
  ): Promise<boolean> {
    if (ciphertext === null || code === undefined) return false;
    let secret: Buffer | undefined;
    try {
      secret = base32Decode(this.cipher.decrypt(adminId, ciphertext).reveal());
    } catch (error) {
      if (!(error instanceof CredentialDecryptionError)) throw error;
      // Chave errada ou texto adulterado: o login falha igual a um código errado; o log leva só o motivo.
      this.logger.warn({ reason: error.reason }, 'segredo do segundo fator não decifra');
      return false;
    }
    if (secret === undefined || secret.length === 0) return false;
    const step = matchTotp(secret, code, this.now());
    if (step === undefined) return false;
    return this.admins.claimTotpStep(adminId, step);
  }
}
