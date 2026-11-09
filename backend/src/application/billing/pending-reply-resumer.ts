import type { FastifyBaseLogger } from 'fastify';
import { describeError } from '../channel/describe-error.js';
import type { InboundJobQueue } from '../ports/inbound-job-queue.js';
import type { PendingReplyReader } from '../ports/pending-reply-reader.js';

/** Quantos contatos no máximo são reativados por pagamento (o resto responde na próxima mensagem). */
export const RESUME_MAX_CONTACTS = 200;

/**
 * Depois de um pagamento aprovado (spec 031, E3), reagenda o flush das mensagens que ficaram pendentes
 * enquanto a IA estava em pausa por cota ou assinatura inativa. Modo ensure, sem espera (a janela de
 * agrupamento já passou). O flush relê os entitlements e o número da empresa no banco; este serviço só
 * os acorda. Melhor esforço: nunca lança e nunca loga contato, só contagens e ids de assinatura.
 */
export class PendingReplyResumer {
  constructor(
    private readonly deps: {
      readonly reader: PendingReplyReader;
      readonly queue: Pick<InboundJobQueue, 'scheduleFlush'>;
      readonly logger: FastifyBaseLogger;
    },
  ) {}

  async resume(subscriptionId: string, reference: string): Promise<number> {
    const { reader, queue, logger } = this.deps;
    let scheduled = 0;
    let failed = 0;
    try {
      const targets = await reader.listForSubscription(subscriptionId, RESUME_MAX_CONTACTS);
      for (const target of targets) {
        const result = await queue.scheduleFlush(
          {
            kind: 'flush',
            companyId: target.companyId,
            phoneNumberId: target.phoneNumberId,
            contactRef: target.contactRef,
            requestId: `billing-${reference}`.slice(0, 128),
          },
          { delayMs: 0, mode: 'ensure' },
        );
        if (result.ok) scheduled += 1;
        else failed += 1;
      }
    } catch (error) {
      logger.error(
        { subscriptionId, ...describeError(error) },
        'não foi possível reativar as mensagens pendentes depois do pagamento',
      );
      return scheduled;
    }
    logger.info(
      { subscriptionId, scheduled, failed },
      'mensagens pendentes reagendadas após o pagamento',
    );
    return scheduled;
  }
}
