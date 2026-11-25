import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { emailSchema } from '../../application/auth/credentials.js';
import type { PlatformIdentity } from '../../application/auth/identity.js';
import { COMPANY_NAME_MAX_LENGTH } from '../../application/companies/company.service.js';
import type {
  InvitationService,
  PlatformInvitationView,
} from '../../application/invitations/invitation.service.js';
import {
  COMPANY_SLUG_PATTERN,
  MEMBERSHIP_ROLES,
  PLATFORM_ACTION_REASONS,
} from '../../domain/index.js';
import { UnauthorizedError } from '../../shared/errors/index.js';
import { requestAuth, requirePlatform } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import {
  platformActionBodySchema,
  platformCompanyParamsSchema,
} from './platform-monitor.validators.js';

export type PlatformInvitationRoutes = Pick<
  InvitationService,
  | 'listForCompany'
  | 'createByPlatform'
  | 'resendByPlatform'
  | 'revokeByPlatform'
  | 'createCompanyWithOwner'
>;

export interface PlatformInvitationControllerOptions {
  readonly invitations: PlatformInvitationRoutes;
}

const reason = z.enum(PLATFORM_ACTION_REASONS);

/** Convidar pela plataforma (spec 045, E3b): qualquer papel, inclusive `OWNER` (D8). */
const inviteBodySchema = z
  .object({ email: emailSchema, role: z.enum(MEMBERSHIP_ROLES), reason })
  .strict();

/** "Nova empresa" (D4): nome, slug e o e-mail de quem será o `OWNER`. */
const createCompanyBodySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(COMPANY_NAME_MAX_LENGTH)
      .refine((value) => !value.includes('\u0000'), 'Nome inválido'),
    slug: z.string().regex(COMPANY_SLUG_PATTERN),
    ownerEmail: emailSchema,
    reason,
  })
  .strict();

const invitationParamsSchema = z.object({ companyId: z.string(), invitationId: z.string() });

const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(30),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

/** O que sai de um convite: e-mail só mascarado; nunca o hash, o segredo nem o link. */
export interface PlatformInvitationResponse {
  readonly id: string;
  readonly emailMasked: string;
  readonly role: string;
  readonly state: 'PENDING' | 'EXPIRED';
  readonly invitedBy: 'membership' | 'platform';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSentAt: string;
  readonly sendCount: number;
}

function toResponse(view: PlatformInvitationView): PlatformInvitationResponse {
  return {
    id: view.id,
    emailMasked: view.emailMasked,
    role: view.role,
    state: view.state,
    invitedBy: view.invitedBy,
    createdAt: view.createdAt.toISOString(),
    expiresAt: view.expiresAt.toISOString(),
    lastSentAt: view.lastSentAt.toISOString(),
    sendCount: view.sendCount,
  };
}

function platformIdentity(request: FastifyRequest): PlatformIdentity {
  const identity = requestAuth(request);
  if (identity.kind !== 'platform') throw new UnauthorizedError();
  return identity;
}

/**
 * Convites da plataforma e "Nova empresa" (spec 045, E3b). Registrado **dentro** do plugin `/platform` (só
 * o cookie com segundo fator; escrita exige `Origin` e `X-Soprei-App`) e só com as contas ligadas (o
 * convite cria a conta no aceite). Toda rota: `requirePlatform()` e perfil `admin`; corpo `strict`; id
 * malformado, inexistente ou de outra empresa = 404 uniforme. Nenhuma resposta traz o e-mail inteiro.
 */
export const platformInvitationController: FastifyPluginCallback<
  PlatformInvitationControllerOptions
> = (app, { invitations }, done) => {
  const route = { config: rateLimitProfile('admin'), onRequest: requirePlatform() };

  app.post('/companies', route, async (request, reply) => {
    const identity = platformIdentity(request);
    const body = createCompanyBodySchema.parse(request.body);
    const created = await invitations.createCompanyWithOwner(
      identity,
      { name: body.name, slug: body.slug, ownerEmail: body.ownerEmail },
      body.reason,
    );
    return reply
      .status(201)
      .send({ companyId: created.companyId, invitation: toResponse(created.invitation) });
  });

  app.get('/companies/:companyId/invitations', route, async (request) => {
    const { companyId } = platformCompanyParamsSchema.parse(request.params);
    const { limit, cursor } = listQuerySchema.parse(request.query);
    const page = await invitations.listForCompany(companyId, {
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    return { items: page.items.map(toResponse), nextCursor: page.nextCursor };
  });

  app.post('/companies/:companyId/invitations', route, async (request, reply) => {
    const identity = platformIdentity(request);
    const { companyId } = platformCompanyParamsSchema.parse(request.params);
    const body = inviteBodySchema.parse(request.body);
    const view = await invitations.createByPlatform(
      identity,
      companyId,
      { email: body.email, role: body.role },
      body.reason,
    );
    return reply.status(201).send(toResponse(view));
  });

  app.post('/companies/:companyId/invitations/:invitationId/resend', route, async (request) => {
    const identity = platformIdentity(request);
    const { companyId, invitationId } = invitationParamsSchema.parse(request.params);
    const body = platformActionBodySchema.parse(request.body);
    return toResponse(
      await invitations.resendByPlatform(identity, companyId, invitationId, body.reason),
    );
  });

  app.post(
    '/companies/:companyId/invitations/:invitationId/revoke',
    route,
    async (request, reply) => {
      const identity = platformIdentity(request);
      const { companyId, invitationId } = invitationParamsSchema.parse(request.params);
      const body = platformActionBodySchema.parse(request.body);
      await invitations.revokeByPlatform(identity, companyId, invitationId, body.reason);
      return reply.status(204).send();
    },
  );

  done();
};
