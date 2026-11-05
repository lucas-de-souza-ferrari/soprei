/**
 * Qual empresa abrir logo depois do login (spec 029), a partir dos vínculos **ativos** da conta (a lista já
 * vem filtrada por empresa ativa e vínculo ativo). A "última usada" é só uma dica: se não está na lista
 * (empresa suspensa, removida ou vínculo desativado), é ignorada. Sem dica válida, a primeira da lista
 * (decisão D3); sem vínculos, `null` (o site mostra a criação da primeira empresa).
 */
export function pickCompanyToOpen(
  memberships: readonly { readonly companyId: string }[],
  lastCompanyId: string | null,
): string | null {
  if (lastCompanyId !== null && memberships.some((item) => item.companyId === lastCompanyId))
    return lastCompanyId;
  return memberships[0]?.companyId ?? null;
}
