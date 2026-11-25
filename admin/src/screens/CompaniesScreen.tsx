import { useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { query } from '../api';
import { useAdmin, usePaged, type View } from '../admin-context';
import {
  ATTENTION_FILTERS,
  companyPageSchema,
  type AttentionFilter,
  type CompanyListItem,
} from '../contracts';
import { errorMessage, formatCount, formatDateTime, label } from '../format';
import { Alert, Badge, Button, List, Loading, PageHeader, RowButton, Select } from '../ui';

type StatusFilter = '' | 'active' | 'suspended' | 'removed';

export const ATTENTION_LABELS: Record<AttentionFilter, string> = {
  pending_messages: 'Mensagens pendentes',
  unsent_replies: 'Respostas não enviadas',
  token_invalid: 'Token inválido',
  token_expiring: 'Token vencendo',
  open_handoffs: 'Atendimento humano aberto',
};

/**
 * O dono na lista (spec 045, E1): o dono ativo mais antigo, mascarado, e "+N" quando há mais de um;
 * "—" sem dono ativo (a linha também leva o selo "Sem dono ativo").
 */
export function ownerText(company: Pick<CompanyListItem, 'owner' | 'owners'>): string {
  if (company.owner === null) return '—';
  const others = company.owners - 1;
  return others > 0
    ? `${company.owner.emailMasked} (+${String(others)})`
    : company.owner.emailMasked;
}

/** Linhas de empresa, usadas também pela tela Canal. */
export function CompanyRows({
  items,
  from,
  label: listLabel,
}: {
  readonly items: readonly CompanyListItem[];
  readonly from: View;
  readonly label: string;
}) {
  const { navigate } = useAdmin();
  if (items.length === 0) return <p className="text-sm text-muted-foreground">Nenhuma empresa.</p>;
  return (
    <List label={listLabel}>
      {items.map((company) => (
        <RowButton
          key={company.id}
          ariaLabel={`Abrir ${company.name}`}
          onOpen={() => navigate({ name: 'company', companyId: company.id, from })}
        >
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{company.name}</span>
            <span className="text-sm text-muted-foreground">{company.slug}</span>
            <Badge tone={company.status === 'SUSPENDED' ? 'bad' : 'neutral'}>
              {label(company.status)}
            </Badge>
            {company.removedAt === null ? null : <Badge tone="bad">Removida</Badge>}
            {company.owners === 0 && company.removedAt === null ? (
              <Badge tone="bad">Sem dono ativo</Badge>
            ) : null}
          </span>
          <span className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span className="break-all">Dono: {ownerText(company)}</span>
            <span>Plano: {company.plan === null ? '—' : label(company.plan)}</span>
            <span>Acesso: {company.access === null ? '—' : label(company.access)}</span>
            <span>Canal: {label(company.channelState)}</span>
            <span>Membros ativos: {formatCount(company.activeMembers)}</span>
            <span>Mensagens (7 dias): {formatCount(company.messages7d)}</span>
            <span>Última atividade: {formatDateTime(company.lastActivityAt)}</span>
          </span>
        </RowButton>
      ))}
    </List>
  );
}

/** Empresas (`GET /platform/companies`): busca por nome ou slug, estado e "precisa de atenção". */
export function CompaniesScreen({
  initialStatus,
  initialAttention,
}: {
  readonly initialStatus: 'active' | 'suspended' | 'removed' | undefined;
  readonly initialAttention: AttentionFilter | undefined;
}) {
  const [status, setStatus] = useState<StatusFilter>(initialStatus ?? '');
  const [attention, setAttention] = useState<AttentionFilter | ''>(initialAttention ?? '');
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const page = usePaged(
    (api, cursor) =>
      api.get(
        `/platform/companies${query({
          status: status === '' ? undefined : status,
          attention: attention === '' ? undefined : attention,
          q,
          cursor: cursor ?? undefined,
          limit: '30',
        })}`,
        companyPageSchema,
      ),
    `${status}|${attention}|${q}`,
  );
  const from: View = {
    name: 'companies',
    ...(status === '' ? {} : { status }),
    ...(attention === '' ? {} : { attention }),
  };

  function search(event: FormEvent) {
    event.preventDefault();
    setQ(draft.trim());
  }

  return (
    <>
      <PageHeader title="Empresas" onRefresh={page.reload} busy={page.loading} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <form onSubmit={search} role="search" className="flex min-w-0 flex-1 items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Buscar por nome ou slug</span>
            <input
              type="search"
              maxLength={64}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-10 w-full min-w-0 rounded-md border border-input bg-card px-3 text-card-foreground"
            />
          </label>
          <Button type="submit" ariaLabel="Buscar">
            <Search aria-hidden className="size-4" />
          </Button>
        </form>
        <Select<StatusFilter>
          label="Estado"
          value={status}
          onChange={setStatus}
          options={[
            ['', 'Todas'],
            ['active', 'Ativas'],
            ['suspended', 'Suspensas'],
            ['removed', 'Removidas'],
          ]}
        />
        <Select<AttentionFilter | ''>
          label="Precisa de atenção"
          value={attention}
          onChange={setAttention}
          options={[
            ['', 'Qualquer'],
            ...ATTENTION_FILTERS.map((key) => [key, ATTENTION_LABELS[key]] as const),
          ]}
        />
      </div>
      {page.error === undefined ? null : <Alert>{errorMessage(page.error)}</Alert>}
      {page.items === undefined || page.items === null ? (
        page.loading ? (
          <Loading />
        ) : null
      ) : (
        <>
          <CompanyRows items={page.items} from={from} label="Empresas" />
          {page.hasMore ? (
            <div className="mt-3">
              <Button onClick={page.more} disabled={page.loading}>
                Carregar mais
              </Button>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
