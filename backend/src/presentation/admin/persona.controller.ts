import type { FastifyPluginCallback } from 'fastify';
import type { AuthService } from '../../application/auth/auth.service.js';
import type { CompanyService } from '../../application/companies/company.service.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { authenticateHook, requirePermission, membershipAuth } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import { putPersonaBodySchema } from './company.validators.js';

export interface AdminPersonaControllerOptions {
  readonly auth: Pick<AuthService, 'authenticate'>;
  readonly metrics?:
    | Pick<Metrics, 'countAuthTokenRejection' | 'countAuthzDenial' | 'countCompanyPersonaUpdate'>
    | undefined;
  readonly companies: Pick<CompanyService, 'getPersona' | 'setPersona'>;
}

/**
 * Persona da própria empresa (spec 023). Registre com `prefix: '/admin/companies'`. O `:companyId`
 * do caminho é conferido contra a identidade pelo `requirePermission` (404 antes de 403) e
 * descartado: o service recebe só o `CompanyId` da identidade, nunca o do caminho nem do corpo
 * (o schema é estrito). O texto da persona é dado pessoal: só volta ao dono; **nunca** vai a log,
 * a label de métrica nem ao armazenamento do navegador (nem o tamanho exato é logado).
 */
export const adminPersonaController: FastifyPluginCallback<AdminPersonaControllerOptions> = (
  app,
  { auth, metrics, companies },
  done,
) => {
  app.addHook('onRequest', authenticateHook({ auth, metrics }));
  const config = rateLimitProfile('admin');
  const onRequest = requirePermission('persona:manage', { companyParam: 'companyId', metrics });

  app.get('/:companyId/persona', { config, onRequest }, async (request) => ({
    persona: await companies.getPersona(membershipAuth(request).companyId),
  }));

  app.put('/:companyId/persona', { config, onRequest }, async (request) => {
    const { companyId, membershipId } = membershipAuth(request);
    const body = putPersonaBodySchema.parse(request.body);
    const persona = await companies.setPersona(companyId, body.persona);
    const action = persona === null ? 'cleared' : 'set';
    try {
      metrics?.countCompanyPersonaUpdate(action);
    } catch (error) {
      request.log.warn({ err: error }, 'falha ao registrar métrica de persona');
    }
    // Só ids e a ação: nunca o texto nem o tamanho.
    request.log.info({ companyId, membershipId, action }, 'persona da empresa atualizada');
    return { persona };
  });

  done();
};
