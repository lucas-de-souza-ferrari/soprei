/**
 * Que empresa abrir depois de carregar a sessão (spec 029, E2). O servidor já pré-seleciona a última usada
 * no login; esta função só decide o que o site faz com o que veio, inclusive quando a pré-seleção falhou
 * ou a sessão é anterior ao deploy:
 * - a sessão tem uma empresa selecionada que está na lista: abre (`open`);
 * - sem seleção (ou seleção que não está mais na lista) e **uma só** empresa: seleciona e abre (`select`);
 * - sem seleção e várias: mostra a tela de empresas (`choose`);
 * - sem empresa nenhuma: a criação da primeira (`create`).
 */
export type CompanyChoice =
  | { readonly kind: 'open'; readonly companyId: string }
  | { readonly kind: 'select'; readonly companyId: string }
  | { readonly kind: 'choose' }
  | { readonly kind: 'create' };

export function pickCompanyToOpen(
  companies: readonly { readonly companyId: string }[],
  selectedCompanyId: string | null,
): CompanyChoice {
  if (selectedCompanyId !== null && companies.some((item) => item.companyId === selectedCompanyId))
    return { kind: 'open', companyId: selectedCompanyId };
  const only = companies[0];
  if (companies.length === 1 && only !== undefined)
    return { kind: 'select', companyId: only.companyId };
  return companies.length === 0 ? { kind: 'create' } : { kind: 'choose' };
}
