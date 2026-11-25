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
