/** Logotipo com versão para fundo claro e para fundo escuro (a classe `dark` decide qual aparece). */
export function Logo({ alt, className }: { alt: string; className?: string }) {
  return (
    <>
      <img src="/soprei-logo.svg" alt={alt} className={`dark:hidden ${className ?? ''}`} />
      <img
        src="/soprei-logo-dark.svg"
        alt={alt}
        className={`hidden dark:block ${className ?? ''}`}
      />
    </>
  );
}
