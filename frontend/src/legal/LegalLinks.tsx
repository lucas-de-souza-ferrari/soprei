import { LEGAL_PAGES } from './legal-page';

/**
 * Links para as páginas legais (spec 032, E1). Links comuns (`<a href>`): as páginas são HTML estático servido
 * pelo nginx, fora do aplicativo, então a navegação recarrega a página de propósito.
 */
export function LegalLinks({ className }: { className?: string }) {
  return (
    <nav aria-label="Privacidade e termos" className={className}>
      {LEGAL_PAGES.map((page) => (
        <a key={page.path} href={page.path}>
          {page.label}
        </a>
      ))}
    </nav>
  );
}
