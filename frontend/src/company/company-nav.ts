import { isWizardPath } from './onboarding-steps';

/**
 * Menu da área da empresa (spec 023): quais abas o papel enxerga, a partir das `permissions` que o
 * servidor devolve em `GET /account/companies`. É só conveniência de tela: o backend continua sendo a
 * barreira (uma aba escondida não protege nada).
 */
export type AreaPage =
  | 'conversas'
  | 'primeirosPassos'
  | 'agenda'
  | 'agendaConfig'
  | 'canal'
  | 'persona'
  | 'conhecimento'
  | 'estoque'
  | 'equipe'
  | 'testar'
  | 'assinatura'
  | 'notificacoes';

/** Ordem do menu: Conversas é a primeira aba e a página inicial de quem pode ler (spec 024). */
export const AREA_PAGES: readonly AreaPage[] = [
  'conversas',
  // Agenda (spec 027): depois de Conversas, só com `schedule:read`.
  'agenda',
  'canal',
  'persona',
  'conhecimento',
  'estoque',
  'equipe',
  'testar',
  // Assinatura (spec 031, E4): só para a conta titular com a cobrança ligada; o site acrescenta a permissão
  // de conta abaixo. Fica antes de Primeiros passos, que continua por último.
  'assinatura',
  // Assistente de primeiros passos (spec 030): só com `onboarding:manage`. Fica por último para nunca ser a
  // primeira tela permitida (a página inicial continua sendo Conversas).
  'primeirosPassos',
];

/**
 * Telas da área que não são aba do menu (spec 027): a configuração da agenda abre por um botão da própria
 * Agenda e só com `schedule:configure`.
 */
const HIDDEN_PAGES: readonly AreaPage[] = ['agendaConfig', 'notificacoes'];

const AREA_PATHS: Readonly<Record<AreaPage, string>> = {
  conversas: '/painel/conversas',
  primeirosPassos: '/painel/primeiros-passos',
  agenda: '/painel/agenda',
  agendaConfig: '/painel/agenda/configurar',
  canal: '/painel/canal',
  persona: '/painel/persona',
  // Base de conhecimento da IA (spec 026): depois de Persona, só com `knowledge:manage`.
  conhecimento: '/painel/conhecimento',
  // Estoque (spec 026, E2): depois de Conhecimento, só com `inventory:manage`.
  estoque: '/painel/estoque',
  // Equipe (spec 025): depois de Persona e antes de Testar, só com `membership:read`.
  equipe: '/painel/equipe',
  testar: '/painel/testar',
  assinatura: '/painel/assinatura',
  // Notificações (spec 038): fora do menu; abre pelo sino do cabeçalho, com `notification:read`.
  notificacoes: '/painel/notificacoes',
};

export const AREA_LABELS: Readonly<Record<AreaPage, string>> = {
  conversas: 'Conversas',
  primeirosPassos: 'Primeiros passos',
  agenda: 'Agenda',
  agendaConfig: 'Configurar agenda',
  canal: 'Canal',
  persona: 'Persona',
  conhecimento: 'Conhecimento',
  estoque: 'Estoque',
  equipe: 'Equipe',
  testar: 'Testar',
  assinatura: 'Assinatura',
  notificacoes: 'Notificações',
};

/**
 * Permissão de CONTA (não de papel): o site a acrescenta às permissões da empresa só para a conta titular da
 * assinatura e com a cobrança ligada. É conveniência de tela; o backend barra de verdade (cookie da conta).
 */
export const BILLING_PERMISSION = 'account:billing';

/** Permissão que dá acesso a cada aba. */
const REQUIRED: Readonly<Record<AreaPage, string>> = {
  conversas: 'conversation:read',
  primeirosPassos: 'onboarding:manage',
  agenda: 'schedule:read',
  agendaConfig: 'schedule:configure',
  canal: 'channel:read',
  persona: 'persona:manage',
  conhecimento: 'knowledge:manage',
  estoque: 'inventory:manage',
  equipe: 'membership:read',
  testar: 'conversation:simulate',
  assinatura: BILLING_PERMISSION,
  notificacoes: 'notification:read',
};

export function areaPath(page: AreaPage): string {
  return AREA_PATHS[page];
}

/** Rota dentro da aba Conversas (spec 024): a lista, uma conversa pelo id ou um id que não é UUID. */
export type ConversasRoute =
  | { readonly kind: 'list' }
  | { readonly kind: 'detail'; readonly id: string }
  | { readonly kind: 'invalid' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONVERSAS_PREFIX = `${AREA_PATHS.conversas}/`;

/**
 * Rota da aba Conversas para um caminho, ou `null` se o caminho não é desta aba. Um segmento que não
 * é UUID é `invalid` (a tela diz "não encontrada" e **não** chama a API); mais de um segmento também.
 */
export function conversasRouteForPath(pathname: string): ConversasRoute | null {
  if (pathname === AREA_PATHS.conversas) return { kind: 'list' };
  if (!pathname.startsWith(CONVERSAS_PREFIX)) return null;
  const rest = pathname.slice(CONVERSAS_PREFIX.length);
  return UUID.test(rest) ? { kind: 'detail', id: rest.toLowerCase() } : { kind: 'invalid' };
}

/** Caminho de uma rota da aba Conversas (o id é sempre um UUID da própria empresa). */
export function conversasPath(route: ConversasRoute): string {
  return route.kind === 'detail' ? `${CONVERSAS_PREFIX}${route.id}` : AREA_PATHS.conversas;
}

export function areaPageForPath(pathname: string): AreaPage | null {
  if (conversasRouteForPath(pathname) !== null) return 'conversas';
  // Qualquer sufixo de /painel/primeiros-passos abre o assistente; a tela decide o passo (spec 030).
  if (isWizardPath(pathname)) return 'primeirosPassos';
  return [...AREA_PAGES, ...HIDDEN_PAGES].find((page) => AREA_PATHS[page] === pathname) ?? null;
}

export function isAreaPage(value: string): value is AreaPage {
  return ([...AREA_PAGES, ...HIDDEN_PAGES] as readonly string[]).includes(value);
}

export function canOpen(page: AreaPage, permissions: readonly string[]): boolean {
  return permissions.includes(REQUIRED[page]);
}

export function allowedPages(permissions: readonly string[]): AreaPage[] {
  return AREA_PAGES.filter((page) => canOpen(page, permissions));
}
