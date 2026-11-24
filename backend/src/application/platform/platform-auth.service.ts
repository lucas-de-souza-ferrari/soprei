import type { FastifyBaseLogger } from 'fastify';
import {
  PlatformAdminId,
  type PlatformAdminRepository,
  type PlatformAuditRepository,
} from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { NotFoundError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import type { AuthService, LoginFailure } from '../auth/auth.service.js';
import type { PlatformIdentity } from '../auth/identity.js';
import type { PlatformSessionStore } from '../ports/platform-session.js';
import { factorFingerprint } from './totp-second-factor.js';

type PlatformAuthMetrics = Pick<Metrics, 'countPlatformSession' | 'countPlatformAction'>;

export interface PlatformAuthServiceDeps {
  readonly credentials: Pick<AuthService, 'verifyPlatformCredentials'>;
  readonly admins: Pick<PlatformAdminRepository, 'findById' | 'findTotpSecret'>;
  readonly sessions: PlatformSessionStore;
  readonly audit: Pick<PlatformAuditRepository, 'create'>;
  readonly logger: FastifyBaseLogger;
  readonly metrics?: PlatformAuthMetrics | undefined;
}

/**
 * Entrada do dono no admin da plataforma pelo cookie (spec 044, E1): senha + segundo fator, sessão no
 * Redis, trilha de entrada e saída. Cada leitura da sessão relê o administrador no banco: desativado,
 * ou com o fator recadastrado ou apagado, a sessão deixa de valer na hora. Nunca loga e-mail, segredo
 * da sessão nem código; só ids e resultados.
 */
export class PlatformAuthService {
  private readonly deps: PlatformAuthServiceDeps;

  constructor(deps: PlatformAuthServiceDeps) {
    this.deps = deps;
  }

  /** Confere senha e código; grava `PLATFORM_LOGIN` e devolve o segredo da sessão (só para o cookie). */
  async login(input: {
    readonly email: string;
    readonly password: string;
    readonly code: string;
  }): Promise<Result<{ readonly secret: string }, LoginFailure>> {
    const verified = await this.deps.credentials.verifyPlatformCredentials(input);
    if (!verified.ok) return verified;
    const { adminId, totpSecretCiphertext } = verified.value;
    // Trilha antes da sessão: se a gravação falha, ninguém entra sem registro.
    await this.deps.audit.create({ adminId, action: 'PLATFORM_LOGIN' });
    const secret = await this.deps.sessions.create(
      adminId,
      factorFingerprint(totpSecretCiphertext),
    );
    this.count('created');
    this.deps.metrics?.countPlatformAction('platform_login');
    this.deps.logger.info({ adminId }, 'entrada no admin da plataforma');
    return Result.ok({ secret });
  }

  /**
   * Quem a sessão representa agora, ou `undefined` (vencida, revogada, admin desativado ou fator
   * trocado). Redis fora: `ServiceUnavailableError` (fail-closed).
   */
  async authenticate(secret: string): Promise<PlatformIdentity | undefined> {
    const session = await this.deps.sessions.read(secret);
    if (session === null) {
      this.count('expired');
      return undefined;
    }
    const adminId = PlatformAdminId.parse(session.adminId);
    const valid = await this.stillValid(adminId, session.factor);
    if (!valid) {
      await this.deps.sessions.revoke(secret);
      this.count('rejected');
      return undefined;
    }
    return { kind: 'platform', adminId, sessionId: session.id };
  }

  /** Apaga a sessão (idempotente); grava `PLATFORM_LOGOUT` só se havia uma sessão viva. */
  async logout(secret: string): Promise<void> {
    const session = await this.deps.sessions.read(secret);
    await this.deps.sessions.revoke(secret);
    if (session === null) return;
    await this.deps.audit.create({
      adminId: PlatformAdminId.parse(session.adminId),
      action: 'PLATFORM_LOGOUT',
    });
    this.count('revoked');
    this.deps.metrics?.countPlatformAction('platform_logout');
    this.deps.logger.info({ adminId: session.adminId }, 'saída do admin da plataforma');
  }

  /** O e-mail do próprio administrador (a tela mostra quem está dentro). */
  async me(identity: PlatformIdentity): Promise<{ readonly email: string }> {
    const admin = await this.deps.admins.findById(identity.adminId);
    return { email: admin.email };
  }

  private async stillValid(adminId: PlatformAdminId, factor: string): Promise<boolean> {
    try {
      const [admin, ciphertext] = await Promise.all([
        this.deps.admins.findById(adminId),
        this.deps.admins.findTotpSecret(adminId),
      ]);
      return (
        admin.status === 'ACTIVE' && ciphertext !== null && factorFingerprint(ciphertext) === factor
      );
    } catch (error) {
      if (error instanceof NotFoundError) return false;
      throw error;
    }
  }

  private count(result: 'created' | 'expired' | 'revoked' | 'rejected'): void {
    try {
      this.deps.metrics?.countPlatformSession(result);
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'falha ao registrar métrica da sessão da plataforma');
    }
  }
}
