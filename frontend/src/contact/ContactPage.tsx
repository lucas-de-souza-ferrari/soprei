import { Logo } from '../components/logo';
import { ThemeToggle } from '../components/motion/theme-toggle';
import { LegalLinks } from '../legal/LegalLinks';
import { SalesContactForm } from './SalesContactForm';

/**
 * Página pública `/fale-conosco` (spec 040, D10): o formulário de contato comercial, montada pelo `main.tsx`
 * fora do `AccountApp` (não lê a sessão). Sem página de preços: só o contato.
 */
export function ContactPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <a className="skip" href="#conteudo">
        Pular para o conteúdo
      </a>
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-4 py-5">
        <a href="/" aria-label="Soprei, página inicial">
          <Logo alt="Soprei" />
        </a>
        <ThemeToggle />
      </header>
      <main id="conteudo" className="mx-auto grid w-full max-w-3xl gap-6 px-4 pb-12">
        <div className="grid gap-2">
          <h1 className="m-0 text-3xl font-semibold">Fale com a gente</h1>
          <p className="m-0 text-muted-foreground">
            Para redes, franquias e operações maiores (plano Enterprise) ou qualquer dúvida
            comercial. Responderemos pelo e-mail informado.
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-5 text-card-foreground">
          <SalesContactForm />
        </div>
      </main>
      <footer className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-4 px-4 pb-8 text-sm">
        <a href="/">Voltar à página inicial</a>
        <LegalLinks className="flex flex-wrap gap-4" />
      </footer>
    </div>
  );
}
