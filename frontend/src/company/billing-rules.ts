import type {
  Billing,
  CatalogPlan,
  CheckHints,
  Cycle,
  Entitlements,
  OrderRow,
  PlanCode,
  Quote,
  Selection,
  Subscription,
} from './billing-api';
import { formatMoney } from './money';

/**
 * Regras puras da tela de Assinatura (spec 031, E4): textos e decisões sem rede nem tela. O navegador **não
 * calcula preço, desconto nem proporcional**: tudo que é dinheiro vem do servidor em centavos e aqui só se
 * formata. Datas chegam em ISO UTC e são exibidas em `dd/MM/aaaa` no fuso do Brasil (formatação explícita).
 */
export const SUBSCRIPTION_PATH = '/painel/assinatura';

const DAY_MS = 86_400_000;
const DATE = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const NUMBER = new Intl.NumberFormat('pt-BR');

export function formatDate(iso: string): string {
  return DATE.format(new Date(iso));
}

export function formatCount(value: number): string {
  return NUMBER.format(value);
}

/** Dias inteiros que faltam até `endIso` (arredonda para cima; nunca negativo). */
export function daysLeft(endIso: string, now: Date): number {
  return Math.max(0, Math.ceil((new Date(endIso).getTime() - now.getTime()) / DAY_MS));
}

export function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

// ---------------------------------------------------------------------------------------------
// Uso e cotas
// ---------------------------------------------------------------------------------------------

export type QuotaLevel = 'ok' | 'warn' | 'full';

/** Porcentagem inteira de uso, de 0 a 100 (limite inválido não conta). */
export function usagePercent(used: number, limit: number): number {
  if (!(limit > 0)) return 0;
  return Math.min(100, Math.floor((Math.max(0, used) * 100) / limit));
}

/** Alertas da tela: a partir de 80% atenção; em 100% a cota acabou. */
export function quotaLevel(used: number, limit: number): QuotaLevel {
  if (!(limit > 0)) return 'ok';
  if (used >= limit) return 'full';
  if (used * 100 >= limit * 80) return 'warn';
  return 'ok';
}

export const QUOTA_TEXT: Readonly<Record<QuotaLevel, string>> = {
  ok: '',
  warn: 'Atenção: você já usou 80% ou mais da cota deste mês.',
  full: 'A cota deste mês acabou: o atendente parou de responder.',
};

export type QuotaReason = 'replies' | 'ai';

/**
 * Qual cota parou o atendente neste mês, ou `null`. A cota de respostas é a que a tela mostra; o limite de uso
 * da IA (tokens) é proteção de custo e fica fora da tela (spec 040, D3): quando ele para o atendente, o texto é
 * genérico e sem números. Com as duas esgotadas vale a de respostas (a que a pessoa enxerga).
 */
export function quotaReason(
  replies: { used: number; limit: number } | null,
  ai: { used: number; limit: number } | null,
): QuotaReason | null {
  if (replies !== null && quotaLevel(replies.used, replies.limit) === 'full') return 'replies';
  if (ai !== null && quotaLevel(ai.used, ai.limit) === 'full') return 'ai';
  return null;
}

/** Título fixo quando o limite de uso da IA parou o atendente (sem número; spec 040, E2). */
export const AI_LIMIT_TITLE = 'O limite de uso da inteligência artificial deste mês foi atingido';

/** Faixa da tela de Assinatura com a cota do mês esgotada (respostas ou limite da IA), ou `null`. */
export function exhaustedBanner(usage: Billing['usage']): Banner | null {
  if (usage === null) return null;
  const reason = quotaReason(usage.replies, usage.tokens);
  if (reason === null) return null;
  return {
    tone: 'error',
    title: reason === 'replies' ? 'Cota do mês esgotada' : AI_LIMIT_TITLE,
    text: `O atendente parou de responder; as mensagens ficam guardadas e visíveis no painel e nada é perdido. Ele volta em ${formatDate(usage.windowEnd)} (início da próxima janela de uso) ou assim que você trocar para um plano maior.`,
  };
}

/** Estimativa do custo na Meta (milésimos de centavo do servidor) em centavos para exibir. */
export function metaEstimateCents(milliCents: number): number {
  return Math.round(Math.max(0, milliCents) / 1000);
}

export const META_ESTIMATE_NOTE =
  'É só uma estimativa. O valor real vem da fatura da Meta (franquia gratuita, impostos e a categoria da mensagem podem mudar o total).';

export const WHATSAPP_NOT_INCLUDED =
  'O plano não inclui o custo das mensagens do WhatsApp: a Meta cobra direto da conta do WhatsApp da sua empresa.';

export function whatsappNotice(
  mode: 'NOT_INCLUDED' | 'INCLUDED_UP_TO_REPLIES',
  includedReplies: number,
): string {
  return mode === 'NOT_INCLUDED'
    ? WHATSAPP_NOT_INCLUDED
    : `O plano inclui o custo do WhatsApp até ${formatCount(includedReplies)} respostas por mês.`;
}

// ---------------------------------------------------------------------------------------------
// Estado da assinatura
// ---------------------------------------------------------------------------------------------

export type Tone = 'info' | 'success' | 'warning' | 'error';
export interface Banner {
  readonly tone: Tone;
  readonly title: string;
  readonly text: string;
}

/** Faixa de estado da tela (texto sempre, nunca só cor). */
export function stateBanner(subscription: Subscription, now: Date): Banner {
  const end = formatDate(subscription.currentPeriodEnd);
  switch (subscription.status) {
    case 'TRIAL': {
      const trialEnd = subscription.trialEndsAt ?? subscription.currentPeriodEnd;
      const days = daysLeft(trialEnd, now);
      return {
        tone: 'info',
        title: 'Teste gratuito',
        text: `${String(days)} ${plural(days, 'dia restante', 'dias restantes')} (termina em ${formatDate(trialEnd)}). Escolha um plano para continuar depois do teste.`,
      };
    }
    case 'ACTIVE':
      return {
        tone: 'success',
        title: 'Assinatura ativa',
        text: `Vale até ${end}. Para continuar sem interrupção, renove antes dessa data.`,
      };
    case 'PAST_DUE':
      return {
        tone: 'warning',
        title: 'Assinatura vencida: período de carência',
        text: `Venceu em ${end}. O atendente e o painel continuam funcionando até ${formatDate(subscription.graceEndsAt)}. Depois disso o atendente para de responder e o painel fica só para leitura. Renove para evitar a interrupção.`,
      };
    case 'CANCELLED':
      return {
        tone: 'warning',
        title: 'Assinatura cancelada',
        text: `Não será renovada e vale até ${end}. Depois dessa data o atendente para de responder e o painel fica só para leitura. Nada é apagado. Você pode reativar antes do fim.`,
      };
    case 'EXPIRED':
      return {
        tone: 'error',
        title: 'Assinatura encerrada',
        text: 'O atendente não responde e o painel está só para leitura. As conversas e os dados continuam guardados; nada foi apagado. Escolha um plano abaixo para voltar a usar.',
      };
  }
}

/** A assinatura cancelada (ou marcada para cancelar) que ainda pode ser reativada. */
export function canReactivate(subscription: Subscription): boolean {
  return subscription.cancelAtPeriodEnd && subscription.access !== 'blocked';
}

export function canCancel(subscription: Subscription): boolean {
  return (
    !subscription.cancelAtPeriodEnd &&
    subscription.status !== 'TRIAL' &&
    subscription.status !== 'EXPIRED'
  );
}

// ---------------------------------------------------------------------------------------------
// Escolha de plano
// ---------------------------------------------------------------------------------------------

export const CYCLE_LABELS: Readonly<Record<Cycle, string>> = {
  MONTHLY: 'Mensal',
  ANNUAL: 'Anual',
};

export const PLAN_FALLBACK_NAMES: Readonly<Record<PlanCode, string>> = {
  ESSENTIAL: 'Essencial',
  PROFESSIONAL: 'Profissional',
  SCALE: 'Escala',
};

export function planName(catalog: readonly CatalogPlan[], code: PlanCode): string {
  return catalog.find((plan) => plan.code === code)?.name ?? PLAN_FALLBACK_NAMES[code];
}

/** Escolha inicial: a assinatura atual (ou, sem ela, o primeiro plano do catálogo no ciclo mensal). */
export function defaultSelection(billing: Billing): Selection {
  const { subscription } = billing;
  if (subscription !== null) {
    return {
      planCode: subscription.planCode,
      cycle: subscription.cycle,
      agenda: subscription.agenda,
      stock: subscription.stock,
    };
  }
  return {
    planCode: billing.catalog[0]?.code ?? 'ESSENTIAL',
    cycle: 'MONTHLY',
    agenda: false,
    stock: false,
  };
}

export function samePlan(a: Selection, b: Selection): boolean {
  return (
    a.planCode === b.planCode && a.cycle === b.cycle && a.agenda === b.agenda && a.stock === b.stock
  );
}

export function priceOf(plan: CatalogPlan, cycle: Cycle) {
  return plan.prices.find((price) => price.cycle === cycle);
}

/** Complemento do ciclo anual no seletor (o catálogo vigente tem anual = 10 x o mensal; spec 040). */
export const CYCLE_NOTES: Readonly<Record<Cycle, string>> = {
  MONTHLY: '',
  ANNUAL: ' (um pagamento por ano: 2 meses grátis)',
};

const PER_REPLY = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

/**
 * Preço por resposta incluída, vindo do servidor em milésimos de centavo (spec 040, D9), formatado com quatro
 * casas: 1.916 vira "equivale a R$ 0,0192 por resposta". Só formatação: o valor é do servidor. Ausente ou 0
 * (servidor anterior, cota inválida) = `null`, e a linha não aparece.
 */
export function perReplyText(milliCents: number | undefined): string | null {
  if (milliCents === undefined || !(milliCents > 0)) return null;
  const money = PER_REPLY.format(milliCents / 100_000).replaceAll(String.fromCharCode(0xa0), ' ');
  return `equivale a ${money} por resposta`;
}

/** O que a cotação do servidor significa para a tela: texto, botão e o que o botão faz. */
export type ChangeAction = 'pay' | 'upgrade' | 'schedule';
export interface QuoteView {
  readonly action: ChangeAction;
  readonly button: string;
  readonly text: string;
}

export function quoteView(quote: Quote, now: Date): QuoteView {
  const money = formatMoney(quote.amountCents);
  switch (quote.kind) {
    case 'NEW':
      return {
        action: 'pay',
        button: 'Pagar',
        text: `Você pagará ${money} agora. Depois do pagamento o plano vale na hora.`,
      };
    case 'RENEWAL':
      return {
        action: 'pay',
        button: 'Renovar',
        text: `Você pagará ${money} agora para renovar. O novo período soma ao atual e nada é cobrado automaticamente.`,
      };
    case 'UPGRADE': {
      const days = quote.remainingDays ?? daysLeft(quote.periodEnd ?? now.toISOString(), now);
      return {
        action: 'upgrade',
        button: 'Pagar a diferença',
        text: `Você pagará ${money} agora, a diferença proporcional dos ${String(days)} ${plural(days, 'dia restante', 'dias restantes')} do período. O plano novo vale na hora e o vencimento não muda.`,
      };
    }
    case 'DOWNGRADE':
    case 'CYCLE_CHANGE':
      return {
        action: 'schedule',
        button: 'Agendar troca',
        text:
          quote.periodEnd === null
            ? 'Nada será cobrado agora. A troca vale a partir da próxima renovação.'
            : `Nada será cobrado agora. A troca vale a partir da renovação, em ${formatDate(quote.periodEnd)}. Você pode desfazer antes disso.`,
      };
  }
}

/** Descrição curta de uma escolha ("Profissional, anual, com Agenda"). */
export function describeSelection(catalog: readonly CatalogPlan[], selection: Selection): string {
  const modules = [selection.agenda ? 'Agenda' : null, selection.stock ? 'Estoque' : null].filter(
    (item) => item !== null,
  );
  return `${planName(catalog, selection.planCode)}, ${CYCLE_LABELS[selection.cycle].toLowerCase()}, ${
    modules.length === 0 ? 'sem módulos' : `com ${modules.join(' e ')}`
  }`;
}

// ---------------------------------------------------------------------------------------------
// Pedidos
// ---------------------------------------------------------------------------------------------

export const ORDER_KIND_LABELS: Readonly<Record<OrderRow['kind'], string>> = {
  NEW: 'Nova assinatura',
  RENEWAL: 'Renovação',
  UPGRADE: 'Troca de plano (diferença)',
  EXTRA_PACK: 'Pacote de respostas',
};

export const ORDER_STATUS_LABELS: Readonly<Record<OrderRow['status'], string>> = {
  PENDING: 'Aguardando pagamento',
  PAID: 'Pago',
  EXPIRED: 'Expirado',
  FAILED: 'Não concluído',
};

/** Pedido que o titular ainda pode confirmar com "Já paguei" (aberto e dentro da validade de 24 h). */
export function canCheckOrder(order: OrderRow, now: Date): boolean {
  return order.status === 'PENDING' && now.getTime() - new Date(order.createdAt).getTime() < DAY_MS;
}

// ---------------------------------------------------------------------------------------------
// Volta do checkout e link de pagamento
// ---------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE = /^[A-Za-z0-9._:-]{1,128}$/;

export interface CheckoutReturn extends CheckHints {
  readonly orderId: string;
}

/**
 * Volta do checkout: a InfinitePay devolve o pagador à página com `order_nsu`, `transaction_nsu` e `slug` na
 * query, que o navegador controla. Aqui só se extrai o que tem o formato esperado, para disparar o "Já
 * paguei" (que o servidor confirma com o provedor): a query nunca concede nada. `null` se não há pedido válido.
 */
export function parseCheckoutReturn(search: string): CheckoutReturn | null {
  const params = new URLSearchParams(search);
  const orderId = params.get('order_nsu');
  if (orderId === null || !UUID.test(orderId)) return null;
  const transactionNsu = params.get('transaction_nsu');
  const slug = params.get('slug');
  return {
    orderId: orderId.toLowerCase(),
    ...(transactionNsu !== null && REFERENCE.test(transactionNsu) ? { transactionNsu } : {}),
    ...(slug !== null && REFERENCE.test(slug) ? { slug } : {}),
  };
}

/**
 * O link do checkout só é aberto se for `https`, sem credenciais embutidas e, quando o servidor informa o host
 * do provedor, só nesse host (defesa em profundidade).
 */
export function safeCheckoutUrl(url: string, allowedHost?: string | null): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
      return null;
    }
    if (allowedHost !== undefined && allowedHost !== null && parsed.hostname !== allowedHost) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Acesso da empresa (faixa para todos os papéis, abas por módulo)
// ---------------------------------------------------------------------------------------------

export interface AccessNotice {
  readonly tone: Tone;
  readonly title: string;
  readonly text: string;
}

/**
 * Aviso que qualquer papel vê no painel da empresa: carência, assinatura encerrada ou cota esgotada. O
 * titular da conta (`holder`) é levado à tela de Assinatura; os demais, a falar com ele. `null` = tudo certo.
 */
export function accessNotice(
  entitlements: Entitlements | null,
  holder: boolean,
): AccessNotice | null {
  if (entitlements === null) return null;
  const how = holder
    ? 'Abra a tela de Assinatura para resolver.'
    : 'Fale com a pessoa titular da conta para resolver.';
  if (entitlements.access === 'blocked') {
    return {
      tone: 'error',
      title: 'Assinatura encerrada',
      text: `O atendente parou de responder e o painel está só para leitura; nada foi apagado. ${how}`,
    };
  }
  if (entitlements.access === 'grace') {
    return {
      tone: 'warning',
      title: 'Assinatura vencida',
      text: `Você está no período de carência: tudo continua funcionando por alguns dias, depois o atendente para de responder. ${how}`,
    };
  }
  // O limite de uso da IA (tokens) não aparece em número em lugar nenhum do site (spec 040, D3).
  const reason = quotaReason(entitlements.replies, entitlements.tokens);
  if (reason === null) return null;
  return {
    tone: 'error',
    title: reason === 'replies' ? 'Respostas do mês esgotadas' : AI_LIMIT_TITLE,
    text: `O atendente parou de responder; as mensagens ficam guardadas e visíveis. Ele volta no início do próximo mês ou ao trocar de plano. ${how}`,
  };
}

export type ContractModuleName = 'agenda' | 'stock';

/** Módulo que uma tela exige, ou `null` (só Agenda e Estoque são módulos). */
export function moduleOfPage(page: string): ContractModuleName | null {
  if (page === 'agenda' || page === 'agendaConfig') return 'agenda';
  if (page === 'estoque') return 'stock';
  return null;
}

/** O módulo foi contratado? Sem leitura do acesso (null) vale como contratado: o backend é a barreira. */
export function hasModule(entitlements: Entitlements | null, module: ContractModuleName): boolean {
  return entitlements === null || entitlements[module];
}

export const MODULE_LABELS: Readonly<Record<ContractModuleName, string>> = {
  agenda: 'Agenda',
  stock: 'Estoque',
};
