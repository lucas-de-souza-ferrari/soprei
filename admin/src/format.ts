import { ApiError } from './api';

/**
 * Regras de formatação do admin (spec 044, E3). Datas no fuso de São Paulo (o do negócio), números e
 * valores em pt-BR. Códigos sem rótulo conhecido aparecem como vieram (um valor novo do servidor não some).
 */
const TIME_ZONE = 'America/Sao_Paulo';

const integer = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dateTime = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const dateOnly = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

export function formatCount(value: number): string {
  return integer.format(value);
}

export function formatCents(cents: number): string {
  return money.format(cents / 100);
}

/** Data e hora (`24/11/2026, 09:30`), ou "—" quando não há. */
export function formatDateTime(iso: string | null): string {
  return iso === null ? '—' : dateTime.format(new Date(iso));
}

export function formatDate(iso: string | null): string {
  return iso === null ? '—' : dateOnly.format(new Date(iso));
}

/** Uso contra a cota: `1.234 de 5.000 (25%)`, ou `1.234 (sem limite)`. */
export function formatUsage(used: number, quota: number | null): string {
  if (quota === null) return `${formatCount(used)} (sem limite)`;
  const percent = quota === 0 ? 100 : Math.floor((used / quota) * 100);
  return `${formatCount(used)} de ${formatCount(quota)} (${String(percent)}%)`;
}

const LABELS: Record<string, string> = {
  // Empresa e acesso
  ACTIVE: 'Ativa',
  SUSPENDED: 'Suspensa',
  DISABLED: 'Desativada',
  // Planos e ciclos
  ESSENTIAL: 'Essencial',
  PROFESSIONAL: 'Profissional',
  SCALE: 'Escala',
  MONTHLY: 'Mensal',
  ANNUAL: 'Anual',
  // Estado efetivo da assinatura
  TRIAL: 'Teste',
  PAST_DUE: 'Em atraso',
  CANCELLED: 'Cancelada',
  EXPIRED: 'Vencida',
  ok: 'Liberado',
  grace: 'Carência',
  blocked: 'Bloqueado',
  // Canal
  NOT_CONNECTED: 'Não conectado',
  CONNECTED: 'Conectado',
  TOKEN_INVALID: 'Token inválido',
  LEGACY: 'Configuração antiga',
  API_ONLY: 'Só API',
  COEXISTENCE: 'Coexistência',
  // Papéis
  // "Dono" (spec 045, E1): quem administra a empresa; "titular" fica para quem paga a assinatura.
  OWNER: 'Dono',
  ADMIN: 'Administrador',
  AGENT: 'Atendente',
  VIEWER: 'Leitura',
  // Pedidos
  NEW: 'Nova assinatura',
  RENEWAL: 'Renovação',
  UPGRADE: 'Troca de plano',
  EXTRA_PACK: 'Pacote extra',
  PENDING: 'Pendente',
  PAID: 'Pago',
  FAILED: 'Falhou',
  // Motivos das ações (D1)
  PAYMENT: 'Pagamento',
  ABUSE: 'Abuso',
  OWNER_REQUEST: 'Pedido do titular',
  OTHER: 'Outro',
  // Motivos de atendimento humano (spec 038)
  CONTACT_REQUESTED: 'Contato pediu',
  CANNOT_HELP: 'IA não soube ajudar',
  COMPLAINT: 'Reclamação',
  SENSITIVE: 'Assunto sensível',
  // Avisos de cobrança
  QUOTA_REPLIES_80: 'Respostas em 80%',
  QUOTA_REPLIES_100: 'Respostas esgotadas',
  QUOTA_TOKENS_80: 'Tokens em 80%',
  QUOTA_TOKENS_100: 'Tokens esgotados',
  PERIOD_ENDING_7D: 'Período acaba em 7 dias',
  PERIOD_ENDING_1D: 'Período acaba amanhã',
  PERIOD_ENDED: 'Período acabou',
  PRICE_CHANGE: 'Mudança de preço',
  PERIOD_GRACE_ENDED: 'Carência acabou',
  PAYMENT_RECEIVED: 'Pagamento recebido',
  PLAN_CHANGE_APPLIED: 'Troca de plano aplicada',
  DOWNGRADE_BLOCKED: 'Redução de plano barrada',
  TRIAL_ENDING: 'Teste acabando',
  TRIAL_ENDED: 'Teste acabou',
  // Fila e tarefas
  waiting: 'Esperando',
  active: 'Em andamento',
  delayed: 'Adiados',
  failed: 'Falharam',
  completed: 'Concluídos',
  prioritized: 'Priorizados',
  'waiting-children': 'Esperando filhos',
  paused: 'Pausados',
  // Contato comercial (spec 040)
  sent: 'Enviados',
  spam: 'Spam',
  too_fast: 'Rápido demais',
  capped: 'Acima do limite por endereço',
  daily_cap: 'Limite diário',
  invalid: 'Inválidos',
  expired: 'Expirados',
  // Serviços
  up: 'No ar',
  down: 'Fora do ar',
  error: 'Erro',
};

/** Rótulo em português de um código fixo do servidor (o próprio código se não houver). */
export function label(code: string): string {
  return LABELS[code] ?? code;
}

/** Mensagem da tela para um erro, só por `status` e `error.code` (nunca o texto do servidor). */
export function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Algo deu errado. Tente novamente.';
  if (error.code === 'NETWORK') return 'Sem conexão com o servidor. Tente novamente.';
  if (error.code === 'INVALID_RESPONSE') return 'O servidor deu uma resposta inesperada.';
  switch (error.status) {
    case 400:
      return 'Confira os dados informados.';
    case 401:
      return 'Sessão encerrada. Entre novamente.';
    case 403:
      return 'Acesso recusado.';
    case 404:
      return 'Não encontrado.';
    case 429:
      return 'Muitas tentativas. Aguarde antes de tentar novamente.';
    case 503:
      return 'Serviço indisponível no momento. Tente novamente em instantes.';
    default:
      return 'Não foi possível concluir. Tente novamente mais tarde.';
  }
}

/**
 * Mensagem de uma ação sobre a conta (spec 045, E2): os códigos de regra que a tela explica; o resto é
 * `errorMessage`. Nunca o texto do servidor.
 */
export function accountActionErrorMessage(error: unknown, action?: string): string {
  if (error instanceof ApiError) {
    // Desativar e encerrar sessões gravam a mudança e a trilha antes de revogar as sessões; o 503 pode ser
    // só da revogação (Redis fora). Repetir é seguro e conclui.
    if (error.status === 503 && (action === 'disable' || action === 'revokeSessions'))
      return 'A ação pode ter sido registrada sem que as sessões tenham sido encerradas: repita para concluir.';
    switch (error.code) {
      case 'CONFIRMATION_INVALID':
        return 'Código do autenticador inválido ou já usado. Espere o próximo código (até 30 s) e tente de novo.';
      case 'LAST_OWNER':
        return 'Esta conta é a única dona ativa de uma empresa ativa. Suspenda a empresa ou transfira a propriedade antes.';
      case 'ALREADY_VERIFIED':
        return 'O e-mail desta conta já está confirmado.';
    }
  }
  return errorMessage(error);
}

/**
 * Mensagem de uma ação sobre a empresa ou um vínculo (spec 045, E3a): os códigos de regra que a tela
 * explica; o resto é `errorMessage`. Nunca o texto do servidor.
 */
export function companyActionErrorMessage(error: unknown, action?: string): string {
  if (error instanceof ApiError) {
    // Mudar papel e desativar gravam a mudança e a trilha antes de encerrar as sessões do vínculo.
    if (error.status === 503 && (action === 'role' || action === 'disable'))
      return 'A ação pode ter sido registrada sem que as sessões tenham sido encerradas: repita para concluir.';
    switch (error.code) {
      case 'CONFIRMATION_INVALID':
        return 'Código do autenticador inválido ou já usado. Espere o próximo código (até 30 s) e tente de novo.';
      case 'CONFIRMATION_MISMATCH':
        return 'O slug digitado não confere com o da empresa.';
      case 'LAST_OWNER':
        return 'A empresa ficaria sem dono ativo. Promova outra pessoa a dono antes.';
      case 'BILLING_DISABLED':
        return 'A cobrança está desligada neste servidor.';
      case 'NO_SUBSCRIPTION':
        return 'A conta não tem assinatura. Inicie o teste gratuito antes.';
      case 'SUBSCRIPTION_EXISTS':
        return 'A conta já tem assinatura (o teste gratuito é um só por conta).';
      case 'ORDER_PENDING':
        return 'Há um pagamento pendente desta assinatura. Espere ele vencer ou ser pago antes de mudar.';
      case 'PLAN_DOWNGRADE_BLOCKED':
        return 'O plano escolhido não comporta as empresas da conta.';
      case 'PLAN_CHANGE_UNAVAILABLE':
        return 'Só uma assinatura paga e em vigor pode ser cancelada ou reativada.';
      case 'PLAN_UNAVAILABLE':
        return 'Este plano não está no catálogo vigente para o ciclo da assinatura.';
      case 'SLUG_TAKEN':
        return 'Já existe uma empresa com este slug (inclusive entre as removidas). Escolha outro.';
      case 'MEMBER_ALREADY_EXISTS':
        return 'Esta pessoa já faz parte da empresa.';
      case 'INVITATION_ALREADY_PENDING':
        return 'Já há um convite pendente para este e-mail. Reenvie o que existe.';
      case 'COMPANY_INACTIVE':
        return 'A empresa está suspensa: reative antes de convidar.';
      case 'INVITATION_LIMIT_REACHED':
        return 'Limite de convites atingido (pendentes, envios do dia ou intervalo entre reenvios). Tente mais tarde.';
      case 'INVITATION_NOT_PENDING':
        return 'Este convite já não está pendente.';
      case 'MEMBER_NOT_ELIGIBLE':
        return 'A pessoa não pode receber isso: o vínculo e a conta precisam estar ativos (e, para dono, com o e-mail confirmado).';
    }
  }
  return errorMessage(error);
}

/** Mensagem da tela Entrar (o 401 é a falha uniforme de credenciais). */
export function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401)
    return 'E-mail, senha ou código incorretos.';
  if (error instanceof ApiError && error.status === 403)
    return 'Este endereço não está autorizado a entrar.';
  return errorMessage(error);
}

/** "Sair" que o servidor não confirmou (503, 403, rede): a sessão continua, e a tela diz isso. */
export function signOutErrorMessage(error: unknown): string {
  return `Não foi possível sair: ${errorMessage(error)} Se persistir, feche o navegador.`;
}

/**
 * O login respondeu 204, mas a leitura da sessão logo depois deu 401: o navegador não guardou o cookie
 * (ex.: cookie `Secure` num endereço sem HTTPS, ou outro hostname).
 */
export const SESSION_NOT_KEPT =
  'O servidor aceitou a entrada, mas o navegador não guardou a sessão (cookie seguro). Confira o endereço do admin.';

/** Código de 6 dígitos: tira tudo o que não é dígito (o autocompletar do celular cola com espaço). */
export function normalizeCode(value: string): string {
  return value.replace(/\D/g, '').slice(0, 6);
}
