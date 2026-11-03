import type { FastifyPluginCallback, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type { AuthService } from '../../application/auth/auth.service.js';
import type { UserAdminService, UserView } from '../../application/users/user-admin.service.js';
import type { Permission } from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { NotFoundError } from '../../shared/errors/index.js';
import { isUuid } from '../../shared/utils/index.js';
import { authenticateHook, requirePermission, userAuth } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import { listQuerySchema } from './attendance.validators.js';
import { toListOptions } from './list-options.js';
import {
  createUserBodySchema,
  resetPasswordBodySchema,
  updateUserBodySchema,
} from './users.validators.js';

export interface AdminUsersControllerOptions {
  readonly auth: Pick<AuthService, 'authenticate'>;
  readonly metrics?: Pick<Metrics, 'countAuthTokenRejection' | 'countAuthzDenial'> | undefined;
  readonly users: UserAdminService;
}

interface UserResponse {
  id: string;
  email: string;
  role: string;
  status: string;
  createdAt: string;
}

function toUserResponse(user: UserView): UserResponse {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}

/** `:userId` que não é UUID nunca existe: 404 uniforme (não 400), igual a usuário de outro cliente. */
function targetUserId(request: FastifyRequest): string {
  const { userId } = request.params as { userId?: unknown };
  if (typeof userId !== 'string' || !isUuid(userId)) {
    throw new NotFoundError('Recurso não encontrado', { context: { entity: 'User' } });
  }
  return userId.toLowerCase();
}

/**
 * Gestão de usuários do próprio cliente (spec 008). Registre com `prefix: '/admin/clients'`. O
 * `:clientId` do caminho é conferido contra o do token pelo `requirePermission` (404 antes de 403)
 * e descartado: o service sempre recebe a identidade do token. Rotas finas; a hierarquia, a
 * regra do último `OWNER` e a auditoria moram no service. Nunca logam e-mail nem senha.
 */
export const adminUsersController: FastifyPluginCallback<AdminUsersControllerOptions> = (
  app,
  { auth, metrics, users },
  done,
) => {
  app.addHook('onRequest', authenticateHook({ auth, metrics }));
  const config = rateLimitProfile('admin');
  const guard = (permission: Permission): onRequestAsyncHookHandler =>
    requirePermission(permission, { clientParam: 'clientId', metrics });

  app.get('/:clientId/users', { config, onRequest: guard('user:read') }, async (request) => {
    const query = listQuerySchema.parse(request.query);
    const page = await users.listUsers(userAuth(request), toListOptions(query));
    return { items: page.items.map(toUserResponse), nextCursor: page.nextCursor };
  });

  app.post(
    '/:clientId/users',
    { config, onRequest: guard('user:manage') },
    async (request, reply) => {
      const body = createUserBodySchema.parse(request.body);
      const created = await users.createUser(userAuth(request), body);
      return reply.status(201).send(toUserResponse(created));
    },
  );

  app.patch(
    '/:clientId/users/:userId',
    { config, onRequest: guard('user:manage') },
    async (request) => {
      const userId = targetUserId(request);
      const body = updateUserBodySchema.parse(request.body);
      const updated = await users.updateUser(userAuth(request), userId, {
        ...(body.role === undefined ? {} : { role: body.role }),
        ...(body.status === undefined ? {} : { status: body.status }),
      });
      return toUserResponse(updated);
    },
  );

  app.post(
    '/:clientId/users/:userId/password',
    { config, onRequest: guard('user:manage') },
    async (request, reply) => {
      const userId = targetUserId(request);
      const { newPassword } = resetPasswordBodySchema.parse(request.body);
      await users.resetPassword(userAuth(request), userId, newPassword);
      return reply.status(204).send();
    },
  );

  done();
};
