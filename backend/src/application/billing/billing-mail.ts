import type { BillingNoticeKind } from '../../domain/index.js';
import type { BillingNoticeMail } from '../ports/billing-mailer.js';

/** Dados que entram no texto: só nome de plano do catálogo, datas e contagens da própria conta. */
export interface BillingMailData {
  readonly planName: string;
  readonly periodEnd: Date;
  /** Fim da carência (vencimento + dias de carência). */
  readonly graceEnd: Date;
  /** Uso da cota do aviso de respostas, quando é um aviso de cota. */
  readonly quota?: { readonly used: number; readonly limit: number } | undefined;
}

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const DATE = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const NUMBER = new Intl.NumberFormat('pt-BR');

/** Nome do plano vem do catálogo, mas é tratado como texto livre: sem controle, quebra de linha nem excesso. */
function cleanName(name: string): string {
  return name.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

export function formatNoticeDate(date: Date): string {
  return DATE.format(date);
}

const ROUTE = '/painel/assinatura';

/** Assuntos fixos (sem nome de plano, valor nem dado da conta). */
export const BILLING_NOTICE_SUBJECTS: Readonly<Record<BillingNoticeKind, string>> = {
  PERIOD_ENDING_7D: 'Sua assinatura do Soprei vence em poucos dias',
  PERIOD_ENDING_1D: 'Sua assinatura do Soprei vence em menos de 24 horas',
  PERIOD_ENDED: 'Sua assinatura do Soprei venceu',
  PERIOD_GRACE_ENDED: 'A carência da sua assinatura do Soprei terminou',
  PAYMENT_RECEIVED: 'Recebemos o seu pagamento no Soprei',
  PLAN_CHANGE_APPLIED: 'Sua troca de plano do Soprei foi aplicada',
  DOWNGRADE_BLOCKED: 'Sua troca de plano agendada não poderá ser aplicada',
  TRIAL_ENDING: 'Seu teste gratuito do Soprei termina em breve',
  TRIAL_ENDED: 'Seu teste gratuito do Soprei terminou',
  QUOTA_REPLIES_80: 'Você já usou 80% das respostas do seu plano do Soprei',
  QUOTA_REPLIES_100: 'As respostas do seu plano do Soprei acabaram',
  QUOTA_TOKENS_80: 'Você já usou 80% da cota de IA do seu plano do Soprei',
  QUOTA_TOKENS_100: 'A cota de IA do seu plano do Soprei acabou',
};

function quotaLine(data: BillingMailData): string {
  return data.quota === undefined
    ? ''
    : `Uso do mês: ${NUMBER.format(data.quota.used)} de ${NUMBER.format(data.quota.limit)} respostas.`;
}

function bodyOf(kind: BillingNoticeKind, data: BillingMailData): string[] {
  const plan = cleanName(data.planName);
  const end = formatNoticeDate(data.periodEnd);
  const graceEnd = formatNoticeDate(data.graceEnd);
  switch (kind) {
    case 'PERIOD_ENDING_7D':
    case 'PERIOD_ENDING_1D':
      return [
        `Sua assinatura do plano ${plan} vence em ${end}.`,
        'Para continuar usando o atendente sem interrupção, renove pela tela de Assinatura. Nada é cobrado automaticamente.',
      ];
    case 'PERIOD_ENDED':
      return [
        `Sua assinatura do plano ${plan} venceu em ${end}.`,
        `Você tem até ${graceEnd} (período de carência) para renovar: até lá o atendente e o painel continuam funcionando. Depois dessa data, o atendente deixa de responder e o painel fica só para leitura. Nada é apagado.`,
      ];
    case 'PERIOD_GRACE_ENDED':
      return [
        `A carência da sua assinatura do plano ${plan} terminou em ${graceEnd}.`,
        'O atendente deixou de responder e o painel está só para leitura; as mensagens recebidas continuam guardadas e nada foi apagado. Ao renovar, tudo volta a funcionar.',
      ];
    case 'PAYMENT_RECEIVED':
      return ['Recebemos o seu pagamento.', `Seu plano ${plan} está ativo e vale até ${end}.`];
    case 'PLAN_CHANGE_APPLIED':
      return [
        'A troca de plano que você agendou foi aplicada na renovação.',
        `Seu plano agora é o ${plan} e vale até ${end}.`,
      ];
    case 'DOWNGRADE_BLOCKED':
      return [
        `Você agendou uma troca de plano para a próxima renovação, que acontece em ${end}, mas a conta tem mais empresas do que o plano novo comporta.`,
        'Enquanto isso for verdade, a troca não poderá ser aplicada. Desfaça a troca na tela de Assinatura ou reduza o número de empresas antes do vencimento.',
      ];
    case 'TRIAL_ENDING':
      return [
        `Seu teste gratuito termina em ${end}.`,
        'Escolha um plano na tela de Assinatura para continuar usando o atendente depois do teste.',
      ];
    case 'TRIAL_ENDED':
      return [
        'Seu teste gratuito terminou.',
        'O atendente deixou de responder e o painel está só para leitura; nada foi apagado. Escolha um plano na tela de Assinatura para voltar a usar.',
      ];
    case 'QUOTA_REPLIES_80':
      return [
        `Você já usou 80% das respostas do seu plano ${plan} neste mês.`,
        quotaLine(data),
        'Ao chegar a 100%, o atendente para de responder até o início do próximo mês ou até você trocar de plano.',
      ];
    case 'QUOTA_REPLIES_100':
      return [
        `As respostas do seu plano ${plan} acabaram neste mês.`,
        quotaLine(data),
        'O atendente parou de responder e as mensagens recebidas continuam guardadas e visíveis no painel. Ele volta no início do próximo mês ou quando você trocar de plano.',
      ];
    case 'QUOTA_TOKENS_80':
      return [
        `Você já usou 80% da cota de uso da IA do seu plano ${plan} neste mês.`,
        'Ao chegar a 100%, o atendente para de responder até o início do próximo mês ou até você trocar de plano.',
      ];
    case 'QUOTA_TOKENS_100':
      return [
        `A cota de uso da IA do seu plano ${plan} acabou neste mês.`,
        'O atendente parou de responder e as mensagens recebidas continuam guardadas e visíveis no painel. Ele volta no início do próximo mês ou quando você trocar de plano.',
      ];
  }
}

/**
 * E-mail de aviso de cobrança em texto simples (pt-BR). O link leva só à tela de Assinatura (sem token nem
 * dado sensível); nenhum valor em dinheiro, dado de cartão ou dado de outra conta entra no texto.
 */
export function billingNoticeMail(
  kind: BillingNoticeKind,
  data: BillingMailData,
  appOrigin: string,
): BillingNoticeMail {
  const lines = [
    ...bodyOf(kind, data).filter((line) => line !== ''),
    '',
    `Abra a tela de Assinatura: ${appOrigin}${ROUTE}`,
    '',
    'Você recebe este aviso por ser o titular da assinatura. Não pedimos senha nem dados de cartão por e-mail.',
  ];
  return { subject: BILLING_NOTICE_SUBJECTS[kind], text: lines.join('\n') };
}
