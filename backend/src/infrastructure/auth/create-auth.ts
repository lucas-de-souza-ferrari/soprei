import type { FastifyBaseLogger } from 'fastify';
import { AuthService, deriveLoginLockSecret } from '../../application/auth/auth.service.js';
import { MembershipAdminService } from '../../application/memberships/membership-admin.service.js';
import type { PlatformAdminRepository, MembershipRepository } from '../../domain/index.js';
import type { Config } from '../config/index.js';
import { versionedAudience, versionedAuthPrefix } from './auth-version.js';
import {
  PrismaAuditRepository,
  PrismaCompanyRepository,
  PrismaPlatformAdminRepository,
  PrismaMembershipAdminUnitOfWork,
  PrismaMembershipRepository,
  type TenantScopedPrisma,
} from '../database/index.js';
import type { Metrics } from '../metrics/index.js';
import type { AuthRedisHandle } from './auth-redis.js';
import { JoseAccessTokenService } from './jose-access-token.service.js';
import { RedisSessionStore } from './redis-session-store.js';
import { ScryptPasswordHasher } from './scrypt-password-hasher.js';

export type AuthConfig = Pick<
  Config,
  | 'JWT_SECRET'
  | 'JWT_ISSUER'
  | 'JWT_AUDIENCE'
  | 'AUTH_ACCESS_TTL_SECONDS'
  | 'AUTH_REFRESH_TTL_SECONDS'
  | 'AUTH_SESSION_MAX_SECONDS'
  | 'AUTH_CLOCK_TOLERANCE_SECONDS'
  | 'AUTH_LOGIN_MAX_FAILURES'
  | 'AUTH_LOGIN_LOCK_SECONDS'
  | 'AUTH_REDIS_PREFIX'
  | 'ACCOUNTS_ENABLED'
>;

export interface AuthComponents {
  readonly service: AuthService;
  /** Gestão de usuários da empresa, troca da própria senha e auditoria (spec 008). */
  readonly membershipAdmin: MembershipAdminService;
  readonly hasher: ScryptPasswordHasher;
  readonly sessions: RedisSessionStore;
  readonly memberships: MembershipRepository;
  readonly platformAdmins: PlatformAdminRepository;
}

/** Liga a autenticação (spec 007): repositórios, hasher, `jose`, sessões no Redis e o serviço. */
export function createAuthComponents(params: {
  readonly config: AuthConfig;
  readonly logger: FastifyBaseLogger;
  readonly prisma: TenantScopedPrisma;
  readonly authRedis: AuthRedisHandle;
  readonly metrics?: Metrics | undefined;
  /** Só para os testes (custo baixo do scrypt); em produção, o padrão. */
  readonly hasher?: ScryptPasswordHasher;
}): AuthComponents {
  const { config, logger, prisma, authRedis, metrics } = params;
  const memberships = new PrismaMembershipRepository(prisma);
  const platformAdmins = new PrismaPlatformAdminRepository(prisma);
  const hasher = params.hasher ?? new ScryptPasswordHasher();
  const sessions = new RedisSessionStore({
    client: authRedis.client,
    logger,
    prefix: versionedAuthPrefix(config.AUTH_REDIS_PREFIX, config.ACCOUNTS_ENABLED),
    idleTtlSeconds: config.AUTH_REFRESH_TTL_SECONDS,
    maxSeconds: config.AUTH_SESSION_MAX_SECONDS,
    accessTtlSeconds: config.AUTH_ACCESS_TTL_SECONDS,
    loginMaxFailures: config.AUTH_LOGIN_MAX_FAILURES,
    loginLockSeconds: config.AUTH_LOGIN_LOCK_SECONDS,
  });
  const service = new AuthService({
    companies: new PrismaCompanyRepository(prisma),
    memberships,
    platformAdmins,
    hasher,
    tokens: new JoseAccessTokenService({
      secret: config.JWT_SECRET,
      issuer: config.JWT_ISSUER,
      audience: versionedAudience(config.JWT_AUDIENCE, config.ACCOUNTS_ENABLED),
      ttlSeconds: config.AUTH_ACCESS_TTL_SECONDS,
      clockToleranceSeconds: config.AUTH_CLOCK_TOLERANCE_SECONDS,
    }),
    sessions,
    logger,
    metrics,
    loginLockSecret: deriveLoginLockSecret(config.JWT_SECRET),
  });
  const membershipAdmin = new MembershipAdminService({
    memberships,
    audit: new PrismaAuditRepository(prisma),
    unitOfWork: new PrismaMembershipAdminUnitOfWork(prisma),
    hasher,
    sessions,
    logger,
    metrics,
    loginLockSecret: deriveLoginLockSecret(config.JWT_SECRET),
  });
  return { service, membershipAdmin, hasher, sessions, memberships, platformAdmins };
}

/**
 * Pré-aquece o hash fictício do login (`dummyHash` é preguiçoso): sem isto, a primeira consulta de
 * conta inexistente depois do boot pagaria dois hashes e seria distinguível. Falha é ignorada (o
 * hash é refeito na primeira necessidade).
 */
export async function warmUpAuth(components: Pick<AuthComponents, 'hasher'>): Promise<void> {
  try {
    await components.hasher.dummyHash();
  } catch {
    // Melhor esforço.
  }
}
