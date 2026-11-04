import { errors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import type { AuthIdentity } from '../../application/auth/identity.js';
import type {
  AccessTokenRejection,
  AccessTokenService,
  IssuedAccessToken,
  VerifiedAccessToken,
} from '../../application/ports/access-token-service.js';
import { CompanyId, PlatformAdminId, MEMBERSHIP_ROLES, MembershipId } from '../../domain/index.js';
import { Result } from '../../shared/types/index.js';
import { isUuid } from '../../shared/utils/index.js';

/** RFC 9068: `typ` do JWT de access token. */
export const ACCESS_TOKEN_TYP = 'at+jwt';
const ALGORITHM = 'HS256';

export interface JoseAccessTokenOptions {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly ttlSeconds: number;
  readonly clockToleranceSeconds: number;
  /** Relógio injetável (testes). */
  readonly now?: () => Date;
}

const uuid = z.string().refine(isUuid, 'uuid');

const claimsSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('membership'),
    sub: uuid,
    cid: uuid,
    role: z.enum(MEMBERSHIP_ROLES),
    sid: uuid,
    iat: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('platform'),
    sub: uuid,
    sid: uuid,
    iat: z.number().int().nonnegative(),
    cid: z.never().optional(),
    role: z.never().optional(),
  }),
]);

/**
 * Access token JWT HS256 com `jose` (a única parte do sistema que conhece a biblioteca; o ESLint
 * impede importá-la de fora de `src/infrastructure/auth/`). A verificação **fixa** o algoritmo
 * (`algorithms: ['HS256']`, nunca o que o token declarar), o `typ`, `iss`, `aud` e as claims
 * obrigatórias. Nunca lança por token ruim.
 */
export class JoseAccessTokenService implements AccessTokenService {
  private readonly key: Uint8Array;
  private readonly options: Omit<JoseAccessTokenOptions, 'secret'>;

  constructor({ secret, ...options }: JoseAccessTokenOptions) {
    this.key = new TextEncoder().encode(secret);
    this.options = options;
  }

  async issue(identity: AuthIdentity): Promise<IssuedAccessToken> {
    const now = (this.options.now ?? (() => new Date()))();
    const issuedAt = Math.floor(now.getTime() / 1000);
    const claims =
      identity.kind === 'membership'
        ? {
            kind: 'membership',
            cid: identity.companyId,
            role: identity.role,
            sid: identity.sessionId,
          }
        : { kind: 'platform', sid: identity.sessionId };
    const subject = identity.kind === 'membership' ? identity.membershipId : identity.adminId;
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: ALGORITHM, typ: ACCESS_TOKEN_TYP })
      .setIssuer(this.options.issuer)
      .setAudience(this.options.audience)
      .setSubject(subject)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + this.options.ttlSeconds)
      .sign(this.key);
    return { token, expiresIn: this.options.ttlSeconds };
  }

  async verify(token: string): Promise<Result<VerifiedAccessToken, AccessTokenRejection>> {
    let payload: unknown;
    try {
      const verified = await jwtVerify(token, this.key, {
        algorithms: [ALGORITHM],
        typ: ACCESS_TOKEN_TYP,
        issuer: this.options.issuer,
        audience: this.options.audience,
        clockTolerance: this.options.clockToleranceSeconds,
        requiredClaims: ['sub', 'iat', 'exp', 'iss', 'aud'],
        ...(this.options.now === undefined ? {} : { currentDate: this.options.now() }),
      });
      payload = verified.payload;
    } catch (error) {
      return Result.err(error instanceof errors.JWTExpired ? 'expired' : 'invalid');
    }
    const parsed = claimsSchema.safeParse(payload);
    if (!parsed.success) return Result.err('invalid');
    const claims = parsed.data;
    const identity: AuthIdentity =
      claims.kind === 'membership'
        ? {
            kind: 'membership',
            membershipId: MembershipId.parse(claims.sub),
            companyId: CompanyId.parse(claims.cid),
            role: claims.role,
            sessionId: claims.sid.toLowerCase(),
          }
        : {
            kind: 'platform',
            adminId: PlatformAdminId.parse(claims.sub),
            sessionId: claims.sid.toLowerCase(),
          };
    return Result.ok({ identity, issuedAt: claims.iat });
  }
}
