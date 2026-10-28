import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type {
  ChannelIntakeService,
  IntakeSummary,
} from '../../application/channel/channel-intake.service.js';
import { BaseError, ForbiddenError, UnauthorizedError } from '../../shared/errors/index.js';
import { messageRef } from '../../shared/utils/index.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import { verifyWhatsappSignature, secretsMatch } from './whatsapp-signature.js';
import { parseWebhookBody } from './whatsapp-webhook.schemas.js';

/** Nome do canal nos labels de métrica. */
const CHANNEL = 'whatsapp';

/** Limite do corpo do webhook: 1 MiB. */
export const WEBHOOK_BODY_LIMIT_BYTES = 1_048_576;

export const WHATSAPP_WEBHOOK_ROUTE = '/webhooks/whatsapp';

/** Resultado de uma requisição ao webhook (label `result`; conjunto fixo). */
export type WebhookRequestResult =
  | 'verification_ok'
  | 'verification_failed'
  | 'ok'
  | 'invalid_signature'
  | 'invalid_payload'
  | 'enqueue_failed';

/** O que o webhook precisa de quem guarda as métricas (o `Metrics` da 004 satisfaz). */
export interface WebhookMetrics {
  countWebhookRequest(channel: string, result: WebhookRequestResult): void;
  countChannelStatus(
    channel: string,
    status: 'sent' | 'delivered' | 'read' | 'played' | 'failed' | 'other',
  ): void;
}

export interface WhatsappWebhookControllerOptions {
  /** `WHATSAPP_APP_SECRET`: só valida a assinatura. */
  readonly appSecret: string;
  /** `WHATSAPP_VERIFY_TOKEN`: só o handshake de verificação. */
  readonly verifyToken: string;
  /** Entrada do canal: resolve o cliente pelo número do negócio e enfileira. */
  readonly intake: Pick<ChannelIntakeService, 'accept'>;
  readonly metrics?: WebhookMetrics;
}

/** `hub.challenge` é um inteiro na prática; aceita só um token simples, nada que possa virar markup. */
const CHALLENGE_PATTERN = /^[A-Za-z0-9._~-]{1,256}$/;

const verificationQuerySchema = z.object({
  'hub.mode': z.string(),
  'hub.verify_token': z.string(),
  'hub.challenge': z.string().regex(CHALLENGE_PATTERN),
});

/**
 * Webhook do WhatsApp Cloud API (spec 011). Registre sem prefixo: as rotas são
 * `GET` e `POST /webhooks/whatsapp`, ambas no perfil de rate limit `webhook` (o limiter da spec 005
 * roda antes de qualquer trabalho e antes de ler o corpo).
 *
 * - `GET`: handshake de verificação (`hub.verify_token` em tempo constante; a query string **nunca**
 *   vai a log, porque carrega o token).
 * - `POST`: corpo lido cru (parser de JSON encapsulado só aqui, Buffer, 1 MiB), assinatura
 *   HMAC-SHA256 em tempo constante **antes** de interpretar o corpo, schema tolerante, e resposta
 *   200 logo depois de enfileirar: nada de LLM nem de chamada ao canal no fluxo síncrono. O
 *   `clientId` nunca vem de cabeçalho, query ou corpo: nasce da resolução do número do negócio no
 *   banco, dentro do `intake`.
 */
export const whatsappWebhookController: FastifyPluginCallback<WhatsappWebhookControllerOptions> = (
  app,
  { appSecret, verifyToken, intake, metrics },
  done,
) => {
  const config = rateLimitProfile('webhook');

  const count = (result: WebhookRequestResult): void => {
    try {
      metrics?.countWebhookRequest(CHANNEL, result);
    } catch (err) {
      app.log.warn(
        { errName: err instanceof Error ? err.name : typeof err },
        'falha ao registrar métrica do webhook',
      );
    }
  };

  // Corpo cru só neste plugin (os demais continuam com o parser padrão): a assinatura é conferida
  // sobre os bytes exatos que a Meta enviou, e o JSON só é interpretado depois dela.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT_BYTES },
    (_request, body, parserDone) => {
      parserDone(null, body);
    },
  );

  app.get(WHATSAPP_WEBHOOK_ROUTE, { config }, (request, reply) => {
    const parsed = verificationQuerySchema.safeParse(request.query);
    const verified =
      parsed.success &&
      parsed.data['hub.mode'] === 'subscribe' &&
      secretsMatch(parsed.data['hub.verify_token'], verifyToken);
    if (!parsed.success || !verified) {
      count('verification_failed');
      // Sem eco do challenge e sem a query string (ela carrega o token) em lugar nenhum.
      request.log.warn('verificação do webhook recusada');
      throw new ForbiddenError('Verificação recusada');
    }
    count('verification_ok');
    return reply
      .header('cache-control', 'no-store')
      .type('text/plain; charset=utf-8')
      .send(parsed.data['hub.challenge']);
  });

  app.post(
    WHATSAPP_WEBHOOK_ROUTE,
    { config, bodyLimit: WEBHOOK_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const raw: unknown = request.body;
      const rawBody = Buffer.isBuffer(raw) ? raw : undefined;
      if (
        rawBody === undefined ||
        !verifyWhatsappSignature(rawBody, request.headers['x-hub-signature-256'], appSecret)
      ) {
        count('invalid_signature');
        request.log.warn('assinatura do webhook inválida; nada foi processado');
        throw new UnauthorizedError('Assinatura inválida');
      }

      // Assinatura válida: dali em diante, o que estiver errado vira 200 (um 4xx faria a Meta
      // retentar sem chance de sucesso e, em excesso, ela desativa a assinatura).
      let body: unknown;
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        count('invalid_payload');
        request.log.warn('corpo do webhook não é JSON; ignorado');
        return reply.status(200).send({ ok: true });
      }

      const parsed = parseWebhookBody(body);
      if (parsed.invalid) {
        request.log.warn('corpo do webhook fora do formato esperado; partes ignoradas');
      }

      for (const status of parsed.statuses) {
        try {
          metrics?.countChannelStatus(CHANNEL, status.status);
        } catch (err) {
          request.log.warn(
            { errName: err instanceof Error ? err.name : typeof err },
            'falha ao registrar métrica de status',
          );
        }
        if (status.status === 'failed') {
          // Sem telefone (`recipient_id`) nem a mensagem de erro; o id vai como referência.
          request.log.warn(
            {
              messageRef: status.messageId === undefined ? undefined : messageRef(status.messageId),
              errorCode: status.errorCode,
            },
            'o canal informou falha na entrega de uma mensagem',
          );
        }
      }

      const summary: IntakeSummary =
        parsed.messages.length === 0
          ? { enqueued: 0, discarded: 0, failed: 0 }
          : await intake.accept(parsed.messages, request.id);

      if (summary.failed > 0) {
        count('enqueue_failed');
        // 500: a Meta reentrega (por dias) e o id determinístico do job impede duplicar o que já entrou.
        throw new BaseError({
          message: 'Falha ao enfileirar',
          code: 'ENQUEUE_FAILED',
          statusCode: 500,
          context: { failed: summary.failed, enqueued: summary.enqueued },
        });
      }
      count(parsed.invalid ? 'invalid_payload' : 'ok');
      return reply.status(200).send({ ok: true });
    },
  );

  done();
};
