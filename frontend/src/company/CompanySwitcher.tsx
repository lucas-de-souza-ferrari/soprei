import { ChevronsUpDown } from 'lucide-react';
import {
  DashboardMenu,
  DashboardMenuContent,
  DashboardMenuItem,
  DashboardMenuRadioGroup,
  DashboardMenuRadioItem,
  DashboardMenuSeparator,
  DashboardMenuTrigger,
} from '../components/dashboard-shell/dashboard-shell';

export interface SwitcherCompany {
  readonly companyId: string;
  readonly name: string;
  readonly roleLabel: string;
}

export interface CompanySwitcherProps {
  readonly current: SwitcherCompany;
  readonly companies: readonly SwitcherCompany[];
  readonly disabled: boolean;
  readonly onSelect: (companyId: string) => void;
  readonly onManage: () => void;
}

/**
 * Seletor de empresa do menu lateral (spec 029), feito com o menu do Dashboard Shell (Radix `DropdownMenu`):
 * botão com `aria-haspopup="menu"`, empresas como `menuitemradio` e "Gerenciar empresas" e "Criar empresa" como
 * `menuitem`. O Radix cuida de teclado (Enter, Espaço e setas abrem; setas, Home e End movem; Esc fecha e
 * devolve o foco ao botão), foco preso e clique fora. O nome da empresa trunca e aparece inteiro em `title`.
 */
export function CompanySwitcher({
  current,
  companies,
  disabled,
  onSelect,
  onManage,
}: CompanySwitcherProps) {
  return (
    <DashboardMenu>
      <DashboardMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Empresa: ${current.name}. Trocar de empresa`}
          title={current.name}
          className="flex w-full items-center gap-2 rounded-lg border border-input bg-card px-3 py-2 text-left text-card-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{current.name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {current.roleLabel}
            </span>
          </span>
          <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DashboardMenuTrigger>
      <DashboardMenuContent
        align="start"
        aria-label="Empresas"
        className="max-h-72 w-(--radix-dropdown-menu-trigger-width)"
      >
        <DashboardMenuRadioGroup
          value={current.companyId}
          onValueChange={(companyId) => {
            if (companyId !== current.companyId) onSelect(companyId);
          }}
        >
          {companies.map((item) => (
            <DashboardMenuRadioItem key={item.companyId} value={item.companyId} title={item.name}>
              <span className="truncate">{item.name}</span>
            </DashboardMenuRadioItem>
          ))}
        </DashboardMenuRadioGroup>
        <DashboardMenuSeparator />
        <DashboardMenuItem onSelect={onManage}>Gerenciar empresas</DashboardMenuItem>
        <DashboardMenuItem onSelect={onManage}>Criar empresa</DashboardMenuItem>
      </DashboardMenuContent>
    </DashboardMenu>
  );
}
