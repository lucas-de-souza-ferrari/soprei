import type { FastifyPluginCallback } from 'fastify';
import type { CompanyService } from '../../application/companies/company.service.js';
import type { Company } from '../../domain/index.js';
import type { AuthService } from '../../application/auth/auth.service.js';
import { authenticateHook, requirePlatform } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import {
  companyParamsSchema,
  createCompanyBodySchema,
  listCompaniesQuerySchema,
  updateCompanyBodySchema,
} from './company.validators.js';

export interface AdminCompaniesControllerOptions {
  /** Verificação do access token (spec 007). */
  readonly auth: Pick<AuthService, 'authenticate'>;
  readonly metrics?: Pick<Metrics, 'countAuthTokenRejection'> | undefined;
  readonly companies: CompanyService;
}

/**
 * Só campos seguros: nada de `deletedAt` nem de detalhe interno. A persona é conteúdo da empresa (spec 044,
 * D8): a plataforma só sabe se existe (`hasPersona`); o texto fica no `PUT .../persona` da própria empresa.
 */
function toResponse(company: Company): {
  id: string;
  name: string;
  slug: string;
  status: string;
  hasPersona: boolean;
  whatsappPhoneNumberId: string | null;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: company.id,
    name: company.name,
    slug: company.slug,
    status: company.status,
    hasPersona: company.persona !== null,
    whatsappPhoneNumberId: company.whatsappPhoneNumberId,
    createdAt: company.createdAt.toISOString(),
    updatedAt: company.updatedAt.toISOString(),
  };
}

/**
 * Rotas administrativas `/admin/companies` (registre com `prefix: '/admin/companies'`). Só o
 * `PlatformAdmin` (access token `kind: platform`) as alcança; `Membership` recebe 403 (spec 007).
 * Finas: autenticam, validam com Zod, chamam o service e deixam o erro subir ao handler
 * central.
 */
export const adminCompaniesController: FastifyPluginCallback<AdminCompaniesControllerOptions> = (
  app,
  { auth, metrics, companies },
  done,
) => {
  app.addHook('onRequest', authenticateHook({ auth, metrics }));
  // Rate limit por perfil (spec 005): todas as rotas daqui são `admin`.
  const config = rateLimitProfile('admin');
  const onRequest = requirePlatform();

  app.post('/', { config, onRequest }, async (request, reply) => {
    const body = createCompanyBodySchema.parse(request.body);
    const company = await companies.create(body);
    request.log.info({ companyId: company.id, slug: company.slug }, 'empresa criada');
    return reply.status(201).send(toResponse(company));
  });

  app.get('/', { config, onRequest }, async (request) => {
    const { limit, cursor } = listCompaniesQuerySchema.parse(request.query);
    const page = await companies.list({
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    return { items: page.items.map(toResponse), nextCursor: page.nextCursor };
  });

  app.get('/:id', { config, onRequest }, async (request) => {
    const { id } = companyParamsSchema.parse(request.params);
    return toResponse(await companies.getById(id));
  });

  app.patch('/:id', { config, onRequest }, async (request) => {
    const { id } = companyParamsSchema.parse(request.params);
    const body = updateCompanyBodySchema.parse(request.body);
    const company = await companies.update(id, body);
    request.log.info({ companyId: company.id }, 'empresa atualizada');
    return toResponse(company);
  });

  app.delete('/:id', { config, onRequest }, async (request, reply) => {
    const { id } = companyParamsSchema.parse(request.params);
    await companies.remove(id);
    request.log.info({ companyId: id }, 'empresa removida');
    return reply.status(204).send();
  });

  done();
};
