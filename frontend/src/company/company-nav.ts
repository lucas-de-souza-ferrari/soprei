/**
 * Menu da área da empresa (spec 023): quais abas o papel enxerga, a partir das `permissions` que o
 * servidor devolve em `GET /account/companies`. É só conveniência de tela: o backend continua sendo a
 * barreira (uma aba escondida não protege nada).
 */
export type AreaPage = 'canal' | 'persona' | 'testar';

export const AREA_PAGES: readonly AreaPage[] = ['canal', 'persona', 'testar'];

const AREA_PATHS: Readonly<Record<AreaPage, string>> = {
  canal: '/painel/canal',
  persona: '/painel/persona',
  testar: '/painel/testar',
};

export const AREA_LABELS: Readonly<Record<AreaPage, string>> = {
  canal: 'Canal',
  persona: 'Persona',
  testar: 'Testar',
};

/** Permissão que dá acesso a cada aba. */
const REQUIRED: Readonly<Record<AreaPage, string>> = {
  canal: 'channel:read',
  persona: 'persona:manage',
  testar: 'conversation:simulate',
};

export function areaPath(page: AreaPage): string {
  return AREA_PATHS[page];
}

export function areaPageForPath(pathname: string): AreaPage | null {
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
