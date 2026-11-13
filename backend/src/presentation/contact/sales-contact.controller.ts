import type { FastifyPluginCallback } from 'fastify';
import {
  salesContactErrorDetails,
  salesContactSchema,
  toSalesContactRequest,
} from '../../application/contact/sales-contact.schema.js';
import {
  SALES_CONTACT_ACCEPTED,
  type SalesContactService,
} from '../../application/contact/sales-contact.service.js';
import { ForbiddenError, ValidationError } from '../../shared/errors/index.js';
import { rateLimitProfile } from '../common/rate-limit.js';

/** Corpo de `POST /contact/sales`: o formulário cabe com folga em 16 KiB. */
export const SALES_CONTACT_BODY_LIMIT = 16 * 1024;

/**
 * Contato comercial (spec 040, E4, D12 a D14). Rotas públicas que não leem cookie nem token: a resposta é a
 * mesma logado ou não, e o pedido não fica ligado a conta nenhuma. Só existem com `ACCOUNTS_ENABLED=true`.
 *
 * - `GET /contact/sales/form-token` (perfil `public`): o token assinado do formulário, sem estado;
 * - `POST /contact/sales` (perfil `contact`, fail-closed): CSRF por `Origin` igual a `APP_ORIGIN` **e**
 *   `X-Soprei-App: web`; corpo inválido = 400 com mensagens fixas por campo (o valor nunca volta); token
 *   alterado ou vencido = 400 `FORM_EXPIRED`; todo o resto = o mesmo 202.
 */
export const salesContactController: FastifyPluginCallback<{
  service: Pick<SalesContactService, 'issueFormToken' | 'submit' | 'recordInvalid'>;
  origin: string;
}> = (app, { service, origin }, done) => {
  app.addHook('onRequest', (request, reply, next) => {
    void reply.header('cache-control', 'no-store');
    if (
      request.method === 'POST' &&
      (request.headers.origin !== origin || request.headers['x-soprei-app'] !== 'web')
    ) {
      next(new ForbiddenError('Origem inválida'));
      return;
    }
    next();
  });

  // Parser próprio (encapsulado neste plugin): o erro do JSON.parse do V8 cita um trecho do corpo, que iria ao
  // log pelo handler central; aqui o JSON malformado vira um 400 de mensagem fixa.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: SALES_CONTACT_BODY_LIMIT },
    (_request, body, parserDone) => {
      try {
        parserDone(null, JSON.parse(body as string) as unknown);
      } catch {
        parserDone(new ValidationError('Dados inválidos'), undefined);
      }
    },
  );

  app.get('/contact/sales/form-token', { config: rateLimitProfile('public') }, () => ({
    formToken: service.issueFormToken(),
  }));

  app.post(
    '/contact/sales',
    { config: rateLimitProfile('contact'), bodyLimit: SALES_CONTACT_BODY_LIMIT },
    async (request, reply) => {
      const parsed = salesContactSchema.safeParse(request.body);
      if (!parsed.success) {
        // Nunca o ZodError no log nem a mensagem dele na resposta: só o resultado e mensagens fixas.
        service.recordInvalid();
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Dados inválidos',
            requestId: request.id,
            details: salesContactErrorDetails(parsed.error),
          },
        });
      }
      await service.submit({
        request: toSalesContactRequest(parsed.data),
        website: parsed.data.website,
        formToken: parsed.data.formToken,
      });
      return reply.status(202).send({ message: SALES_CONTACT_ACCEPTED });
    },
  );
  done();
};
