import type { ComponentProps, ReactNode } from 'react';
import {
  Bell,
  BookOpen,
  CalendarDays,
  FlaskConical,
  ListChecks,
  MessageSquare,
  Package,
  CreditCard,
  Radio,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { Logo } from '../components/logo';
import { LEGAL_LINKS_LABEL } from '../legal/LegalLinks';
import { Button } from '../components/motion/button';
import { ThemeToggle } from '../components/motion/theme-toggle';
import { DashboardShell } from '../components/dashboard-shell/dashboard-shell';
import { AREA_LABELS, areaPath, isAreaPage, type AreaPage } from './company-nav';
import { CompanySwitcher, type SwitcherCompany } from './CompanySwitcher';

const ICONS: Readonly<Record<AreaPage, LucideIcon>> = {
  conversas: MessageSquare,
  primeirosPassos: ListChecks,
  agenda: CalendarDays,
  agendaConfig: CalendarDays,
  canal: Radio,
  persona: UserRound,
  conhecimento: BookOpen,
  estoque: Package,
  equipe: Users,
  testar: FlaskConical,
  assinatura: CreditCard,
  notificacoes: Bell,
};

export interface AppShellProps {
  /** Título da tela (`h1`). */
  readonly title: string;
  /** Aviso do site (erro, informação) acima do conteúdo. */
  readonly banner?: ReactNode;
  /** Ações à direita do título (spec 038: o sino de notificações). */
  readonly headerActions?: ReactNode;
  readonly children: ReactNode;
  readonly current: SwitcherCompany;
  readonly companies: readonly SwitcherCompany[];
  /** Telas permitidas pela `permissions` (o menu mostra só elas). */
  readonly pages: readonly AreaPage[];
  /** Tela atual (`agendaConfig` conta como Agenda). */
  readonly page: AreaPage;
  readonly email: string;
  readonly busy: boolean;
  readonly onNavigate: (page: AreaPage) => void;
  readonly onSelectCompany: (companyId: string) => void;
  readonly onManage: () => void;
  readonly onLogout: () => void;
}

/** Link do menu: clique simples navega pelo site sem recarregar; com Ctrl, Cmd ou Shift o navegador decide. */
function ShellLink({ onClick, ...props }: ComponentProps<'a'>) {
  return (
    <a
      {...props}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        onClick?.(event);
      }}
    />
  );
}

/**
 * Moldura da área da empresa (spec 029): o Dashboard Shell da Obsidian UI (MIT, copiado e adaptado; ver
 * `NOTICE.md`): menu lateral fixo a partir de 768 px e, abaixo disso, gaveta com foco preso, Esc e conteúdo de
 * trás inerte. O seletor de empresa, o e-mail, o tema e "Sair" ficam no menu; trocar de empresa remonta tudo
 * (`key`), então a gaveta fecha e nada da empresa anterior sobra.
 */
export function AppShell({
  title,
  banner,
  headerActions,
  children,
  current,
  companies,
  pages,
  page,
  email,
  busy,
  onNavigate,
  onSelectCompany,
  onManage,
  onLogout,
}: AppShellProps) {
  const active = page === 'agendaConfig' ? 'agenda' : page;
  return (
    <div className="h-dvh">
      <DashboardShell
        key={current.companyId}
        brand={{
          name: '',
          logo: (
            <a href="/" className="block w-[120px]">
              <Logo alt="Soprei — início" className="w-full" />
            </a>
          ),
        }}
        sidebarHeader={
          <CompanySwitcher
            current={current}
            companies={companies}
            disabled={busy}
            onSelect={onSelectCompany}
            onManage={onManage}
          />
        }
        navigation={[
          {
            id: 'menu',
            items: pages.map((item) => ({
              id: item,
              label: AREA_LABELS[item],
              icon: ICONS[item],
              href: areaPath(item),
            })),
          },
        ]}
        linkComponent={ShellLink}
        activeItemId={active}
        onActiveItemChange={(id) => {
          if (isAreaPage(id)) onNavigate(id);
        }}
        title={title}
        headerActions={headerActions}
        sidebarFooter={
          <div className="grid gap-3">
            <p className="m-0 truncate text-xs text-muted-foreground" title={email}>
              {email}
            </p>
            {/* Spec 032 (E1): link comum para a página estática (fora do aplicativo). */}
            <a
              href="/privacidade"
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {LEGAL_LINKS_LABEL}
            </a>
            <div className="flex items-center justify-between gap-2">
              <ThemeToggle />
              <Button variant="outline" size="sm" onClick={onLogout} disabled={busy}>
                Sair
              </Button>
            </div>
          </div>
        }
      >
        <main className="mx-auto grid w-full max-w-5xl grid-cols-[minmax(0,1fr)] gap-5 px-4 py-6 sm:px-6">
          {banner}
          {children}
        </main>
      </DashboardShell>
    </div>
  );
}
