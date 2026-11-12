import { LEGAL_PAGES } from './legal-page';

/**
 * Endereços legais publicados (spec 032, D2), definidos no build pelo plugin `soprei-legal-pages` a partir da
 * `situacao` dos textos. Fora do Vite (testes no Node) o valor não existe e vale o conservador: só as páginas
 * que vão ao ar em rascunho (os termos ficam de fora até ficarem `vigente`).
 */
function readPublishedPaths(): readonly string[] {
  let value: string | undefined;
  try {
    value = import.meta.env.SOPREI_LEGAL_PUBLISHED;
  } catch {
    value = undefined;
  }
  if (typeof value === 'string') return value.split(',');
  return LEGAL_PAGES.filter((page) => page.publishDraft).map((page) => page.path);
}

const PUBLISHED = readPublishedPaths();

/** Se os Termos de Uso estão publicados (links e rótulos do site dependem disso). */
export const TERMS_PUBLISHED = PUBLISHED.includes('/termos');

/** Rótulo do grupo de links: "Privacidade e termos" só com os termos publicados. */
export const LEGAL_LINKS_LABEL = TERMS_PUBLISHED ? 'Privacidade e termos' : 'Privacidade';

/**
 * Links para as páginas legais publicadas (spec 032, E1). Links comuns (`<a href>`): as páginas são HTML
 * estático servido pelo nginx, fora do aplicativo, então a navegação recarrega a página de propósito.
 */
export function LegalLinks({ className }: { className?: string }) {
  return (
    <nav aria-label={LEGAL_LINKS_LABEL} className={className}>
      {LEGAL_PAGES.filter((page) => PUBLISHED.includes(page.path)).map((page) => (
        <a key={page.path} href={page.path}>
          {page.label}
        </a>
      ))}
    </nav>
  );
}
