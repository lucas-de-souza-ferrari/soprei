import type { FastifyBaseLogger } from 'fastify';
import { SALES_CONTACT_MAX_IN_FLIGHT, type SalesContactRequest } from '../../domain/index.js';
import type { Metrics, SalesContactResult } from '../../infrastructure/metrics/index.js';
import { ValidationError } from '../../shared/errors/index.js';
import type { SalesContactDailyCap, SalesContactMailer } from '../ports/sales-contact.js';
import { checkFormToken, issueFormToken } from './form-token.js';
import { SALES_CONTACT_MAIL_SUBJECT, salesContactMailText } from './sales-contact-mail.js';

/** Resposta única do 202 (sucesso, honeypot, envio rápido demais, teto ou fila cheia). */
export const SALES_CONTACT_ACCEPTED =
  'Recebemos o seu contato. Responderemos pelo e-mail informado.';
export const FORM_EXPIRED_MESSAGE = 'Recarregue a página e tente de novo.';

/** Destinatário dos pedidos (D11): `SALES_CONTACT_EMAIL` e, sem ela, `EMAIL_PROVIDER_FROM`. */
export function salesContactRecipient(config: {
  readonly SALES_CONTACT_EMAIL?: string | undefined;
  readonly EMAIL_PROVIDER_FROM?: string | undefined;
}): string {
  return config.SALES_CONTACT_EMAIL ?? config.EMAIL_PROVIDER_FROM ?? '';
}

export interface SalesContactServiceDeps {
  readonly mailer: SalesContactMailer;
  readonly cap: SalesContactDailyCap;
  /** Chave do token do formulário (`deriveSalesContactKey(JWT_SECRET)`). */
  readonly formKey: Buffer;
  /** `SALES_CONTACT_EMAIL` ou, sem ela, `EMAIL_PROVIDER_FROM` (D11). */
  readonly recipient: string;
  readonly logger: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  readonly metrics?: Pick<Metrics, 'countSalesContact'>;
  readonly now?: () => Date;
}

export interface SalesContactSubmission {
  readonly request: SalesContactRequest;
  /** Honeypot: qualquer coisa além de espaço é robô. */
  readonly website?: string | undefined;
  readonly formToken: string;
}

/**
 * Formulário de contato comercial (spec 040, E4). Nada vai ao banco (D15) e nada volta ao interessado (D16):
 * o pedido vira um e-mail para a caixa comercial, enviado em segundo plano. Log e métrica só com o resultado
 * (o `requestId` vem do contexto); nome, e-mail, telefone, empresa, mensagem, token e honeypot nunca.
 */
export class SalesContactService {
  private readonly pending = new Set<Promise<void>>();
  /** Dia (UTC) do último `warn` do teto diário. */
  private capWarnedDay: string | undefined;
  private readonly now: () => Date;

  constructor(private readonly deps: SalesContactServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  issueFormToken(): string {
    return issueFormToken(this.deps.formKey, this.now().getTime());
  }

  /** Corpo inválido (400 na rota): só a métrica e o resultado no log. */
  recordInvalid(): void {
    this.settle('invalid');
  }

  /**
   * Resolve sem erro em todo caso aceito (202 uniforme, inclusive descartes silenciosos). Lança
   * `ValidationError` `FORM_EXPIRED` (token alterado ou vencido) e `ServiceUnavailableError` se o teto diário
   * não pode ser conferido (nada é enviado).
   */
  async submit(submission: SalesContactSubmission): Promise<void> {
    if ((submission.website ?? '').trim() !== '') {
      this.settle('spam');
      return;
    }
    const now = this.now();
    const token = checkFormToken(this.deps.formKey, submission.formToken, now.getTime());
    if (token === 'expired') {
      this.settle('expired');
      throw new ValidationError(FORM_EXPIRED_MESSAGE, { code: 'FORM_EXPIRED' });
    }
    if (token === 'too_fast') {
      this.settle('too_fast');
      return;
    }
    if (this.pending.size >= SALES_CONTACT_MAX_IN_FLIGHT) {
      this.settle('capped');
      return;
    }
    // Redis fora: o ServiceUnavailableError sobe (503) antes de qualquer envio.
    const day = now.toISOString().slice(0, 10);
    if (!(await this.deps.cap.take(day))) {
      this.settle('daily_cap');
      // Alerta do dono (pedidos legítimos do dia passam a ser descartados): no máximo um `warn` por dia por
      // processo, só com o resultado.
      if (this.capWarnedDay !== day) {
        this.capWarnedDay = day;
        this.deps.logger.warn({ result: 'daily_cap' }, 'teto diário do contato comercial atingido');
      }
      return;
    }
    this.send(submission.request);
  }

  /** Espera os envios em andamento (desligamento); nunca rejeita. */
  async drain(timeoutMs = 10_000): Promise<void> {
    if (this.pending.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([Promise.allSettled([...this.pending]).then(() => undefined), limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  private send(request: SalesContactRequest): void {
    const mail = {
      subject: SALES_CONTACT_MAIL_SUBJECT,
      text: salesContactMailText(request),
      replyTo: request.email,
    };
    const task: Promise<void> = this.deps.mailer
      .sendSalesContact(this.deps.recipient, mail)
      .then(
        () => {
          this.settle('sent');
        },
        () => {
          this.settle('failed');
        },
      )
      .catch(() => undefined)
      .finally(() => {
        this.pending.delete(task);
      });
    this.pending.add(task);
  }

  private settle(result: SalesContactResult): void {
    try {
      this.deps.metrics?.countSalesContact(result);
    } catch {
      // Métrica nunca derruba o pedido.
    }
    if (result === 'failed') this.deps.logger.warn({ result }, 'contato comercial não enviado');
    else this.deps.logger.info({ result }, 'contato comercial');
  }
}
