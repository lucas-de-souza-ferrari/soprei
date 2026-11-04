/**
 * Menu da área da empresa (spec 023): quais abas o papel enxerga, a partir das `permissions` que o
 * servidor devolve em `GET /account/companies`. É só conveniência de tela: o backend continua sendo a
 * barreira (uma aba escondida não protege nada).
 */
export type AreaPage = 'conversas' | 'canal' | 'persona' | 'testar';

/** Ordem do menu: Conversas é a primeira aba e a página inicial de quem pode ler (spec 024). */
export const AREA_PAGES: readonly AreaPage[] = ['conversas', 'canal', 'persona', 'testar'];

const AREA_PATHS: Readonly<Record<AreaPage, string>> = {
  conversas: '/painel/conversas',
  canal: '/painel/canal',
  persona: '/painel/persona',
  testar: '/painel/testar',
};

export const AREA_LABELS: Readonly<Record<AreaPage, string>> = {
  conversas: 'Conversas',
  canal: 'Canal',
  persona: 'Persona',
  testar: 'Testar',
};

/** Permissão que dá acesso a cada aba. */
const REQUIRED: Readonly<Record<AreaPage, string>> = {
  conversas: 'conversation:read',
  canal: 'channel:read',
  persona: 'persona:manage',
  testar: 'conversation:simulate',
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
  return AREA_PAGES.find((page) => AREA_PATHS[page] === pathname) ?? null;
}

export function isAreaPage(value: string): value is AreaPage {
  return (AREA_PAGES as readonly string[]).includes(value);
}

export function canOpen(page: AreaPage, permissions: readonly string[]): boolean {
  return permissions.includes(REQUIRED[page]);
}

export function allowedPages(permissions: readonly string[]): AreaPage[] {
  return AREA_PAGES.filter((page) => canOpen(page, permissions));
}
