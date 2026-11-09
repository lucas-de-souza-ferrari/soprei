import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { CheckoutService } from '../../application/billing/checkout.service.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { isUuid } from '../../shared/utils/index.js';
import { rateLimitProfile } from '../common/rate-limit.js';

/** Limite do corpo do webhook da InfinitePay: 16 KiB (spec 031); o conteúdo só serve para extrair ids. */
export const INFINITEPAY_WEBHOOK_BODY_LIMIT_BYTES = 16 * 1024;

export const INFINITEPAY_WEBHOOK_ROUTE = '/webhooks/infinitepay/:orderId';

export interface InfinitepayWebhookControllerOptions {
  readonly checkout: Pick<CheckoutService, 'acceptWebhook'>;
  readonly metrics?: Pick<Metrics, 'countBillingWebhook'> | undefined;
}

/** Só referências curtas e bem formadas entram; o resto do corpo (valores, recibo, itens, pagador) é ignorado. */
const REFERENCE = /^[A-Za-z0-9._:-]{1,128}$/;
const reference = z.string().regex(REFERENCE).optional().catch(undefined);

const eventSchema = z.object({
  order_nsu: reference,
  transaction_nsu: reference,
  invoice_slug: reference,
});

/**
 * Webhook da InfinitePay (spec 031, E3; D14). Pública e sem assinatura: **o corpo não é confiado**. Registre
 * sem prefixo (só existe com CHECKOUT_ENABLED). A rota só grava a referência mínima (idempotente), responde
 * 200 logo (menos de 1 s: nada de chamada ao provedor no fluxo síncrono) e a confirmação por payment_check
 * roda em segundo plano. Falha transitória ao gravar responde 400 para a InfinitePay tentar de novo. Pedido
 * desconhecido, malformado ou de outra rota responde o mesmo 200 sem efeito (nada vaza). O corpo inteiro,
 * o recibo e o pagador nunca vão a log, métrica nem banco.
 */
export const infinitepayWebhookController: FastifyPluginCallback<
  InfinitepayWebhookControllerOptions
> = (app, { checkout, metrics }, done) => {
  const config = rateLimitProfile('webhook');
  const count = (result: 'invalid' | 'error'): void => {
    try {
      metrics?.countBillingWebhook(result);
    } catch {
      app.log.warn('falha ao registrar métrica do webhook de pagamento');
    }
  };

  app.post<{ Params: { orderId: string } }>(
    INFINITEPAY_WEBHOOK_ROUTE,
    { config, bodyLimit: INFINITEPAY_WEBHOOK_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const { orderId } = request.params;
      if (!isUuid(orderId)) {
        count('invalid');
        return reply.code(200).send({ received: true });
      }
      const parsed = eventSchema.safeParse(request.body);
      if (!parsed.success) {
        count('invalid');
        return reply.code(200).send({ received: true });
      }
      try {
        await checkout.acceptWebhook(orderId, {
          orderNsu: parsed.data.order_nsu,
          transactionNsu: parsed.data.transaction_nsu,
          invoiceSlug: parsed.data.invoice_slug,
        });
      } catch (error) {
        // Falha ao gravar (banco fora): 400 faz a InfinitePay repetir o evento; nada foi concedido.
        count('error');
        request.log.warn(
          { orderId, errName: error instanceof Error ? error.name : typeof error },
          'falha ao registrar o evento de pagamento; a InfinitePay deve repetir',
        );
        return reply.code(400).send({
          error: {
            code: 'WEBHOOK_RETRY',
            message: 'Não foi possível registrar o evento agora',
            requestId: request.id,
          },
        });
      }
      return reply.code(200).send({ received: true });
    },
  );
  done();
};
