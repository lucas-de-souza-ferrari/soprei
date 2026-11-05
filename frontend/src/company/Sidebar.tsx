import type { ReactNode } from 'react';
import {
  BookOpen,
  CalendarDays,
  FlaskConical,
  MessageSquare,
  Package,
  Radio,
  UserRound,
  Users,
} from 'lucide-react';
import { Logo } from '../components/logo';
import { Button } from '../components/motion/button';
import { ThemeToggle } from '../components/motion/theme-toggle';
import { AREA_LABELS, areaPath, type AreaPage } from './company-nav';
import { CompanySwitcher, type SwitcherCompany } from './CompanySwitcher';

const ICONS: Readonly<Record<AreaPage, ReactNode>> = {
  conversas: <MessageSquare aria-hidden="true" className="size-4 shrink-0" />,
  agenda: <CalendarDays aria-hidden="true" className="size-4 shrink-0" />,
  agendaConfig: <CalendarDays aria-hidden="true" className="size-4 shrink-0" />,
  canal: <Radio aria-hidden="true" className="size-4 shrink-0" />,
  persona: <UserRound aria-hidden="true" className="size-4 shrink-0" />,
  conhecimento: <BookOpen aria-hidden="true" className="size-4 shrink-0" />,
  estoque: <Package aria-hidden="true" className="size-4 shrink-0" />,
  equipe: <Users aria-hidden="true" className="size-4 shrink-0" />,
  testar: <FlaskConical aria-hidden="true" className="size-4 shrink-0" />,
};

export interface SidebarProps {
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

/**
 * Conteúdo do menu lateral (spec 029): logo, seletor de empresa, navegação e rodapé. É o mesmo no
 * computador (barra fixa) e no celular (painel por cima).
 */
export function Sidebar({
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
}: SidebarProps) {
  const active = page === 'agendaConfig' ? 'agenda' : page;
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <a href="/" className="block w-[120px]">
        <Logo alt="Soprei — início" className="w-full" />
      </a>
      <CompanySwitcher
        current={current}
        companies={companies}
        disabled={busy}
        onSelect={onSelectCompany}
        onManage={onManage}
      />
      <nav aria-label="Menu da empresa" className="min-h-0 flex-1 overflow-y-auto">
        <ul className="m-0 grid list-none gap-1 p-0">
          {pages.map((item) => (
            <li key={item}>
              <a
                href={areaPath(item)}
                data-nav={item}
                aria-current={item === active ? 'page' : undefined}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
                    return;
                  event.preventDefault();
                  onNavigate(item);
                }}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors motion-reduce:transition-none ${
                  item === active
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {ICONS[item]}
                <span>{AREA_LABELS[item]}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="grid gap-3 border-t border-border pt-3">
        <p className="m-0 truncate text-xs text-muted-foreground" title={email}>
          {email}
        </p>
        <div className="flex items-center justify-between gap-2">
          <ThemeToggle />
          <Button variant="outline" size="sm" onClick={onLogout} disabled={busy}>
            Sair
          </Button>
        </div>
      </div>
    </div>
  );
}
