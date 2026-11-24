import { useState } from 'react';
import { ArrowLeft, Eye } from 'lucide-react';
import { ApiError, query } from '../api';
import { useAdmin, usePaged } from '../admin-context';
import {
  accountDetailSchema,
  accountPageSchema,
  type AccountDetail,
  type AccountListItem,
} from '../contracts';
import { errorMessage, formatCount, formatDate, formatDateTime, label } from '../format';
import {
  Alert,
  Badge,
  Button,
  Card,
  Facts,
  List,
  Loading,
  PageHeader,
  RowButton,
  Select,
} from '../ui';

type StatusFilter = '' | 'active' | 'disabled';
type VerifiedFilter = '' | 'true' | 'false';

/**
 * Detalhe de uma conta (D7): mostra o que a lista já trouxe (e-mail mascarado). O e-mail completo, as
 * empresas e a assinatura só vêm de `GET /platform/accounts/:accountId`, chamado pelo botão "Mostrar
 * e-mail": é essa leitura que o servidor audita. O e-mail fica só no estado desta tela.
 */
function AccountDetailPanel({
  account,
  onBack,
}: {
  readonly account: AccountListItem;
  readonly onBack: () => void;
}) {
  const { api, expire, navigate } = useAdmin();
  const [detail, setDetail] = useState<AccountDetail | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  async function reveal() {
    setBusy(true);
    setError(undefined);
    try {
      setDetail(
        await api.get(`/platform/accounts/${encodeURIComponent(account.id)}`, accountDetailSchema),
      );
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) return expire();
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="mb-2">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft aria-hidden className="size-4" />
          Voltar
        </Button>
      </div>
      <h1 className="mb-4 text-xl font-semibold">Conta</h1>
      <div className="flex flex-col gap-4">
        <Card>
          <Facts
            items={[
              ['E-mail', detail?.email ?? account.emailMasked],
              ['Estado', label(detail?.status ?? account.status)],
              ['E-mail confirmado', (detail?.verified ?? account.verified) ? 'Sim' : 'Não'],
              ['Criada em', formatDateTime(account.createdAt)],
              ['Empresas', formatCount(detail?.companies.length ?? account.companies)],
              ['Tem assinatura', account.hasSubscription ? 'Sim' : 'Não'],
            ]}
          />
          {detail === undefined ? (
            <div className="mt-3 flex flex-col gap-1">
              <div>
                <Button onClick={() => void reveal()} disabled={busy}>
                  <Eye aria-hidden className="size-4" />
                  Mostrar e-mail
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                A leitura do e-mail completo fica registrada na auditoria.
              </p>
            </div>
          ) : null}
          {error === undefined ? null : <Alert>{errorMessage(error)}</Alert>}
        </Card>
        {detail === undefined ? null : (
          <>
            <Card title="Empresas da conta">
              {detail.companies.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhuma empresa.</p>
              ) : (
                <List label="Empresas da conta">
                  {detail.companies.map((company) => (
                    <RowButton
                      key={company.id}
                      ariaLabel={`Abrir ${company.name}`}
                      onOpen={() =>
                        navigate({
                          name: 'company',
                          companyId: company.id,
                          from: { name: 'accounts' },
                        })
                      }
                    >
                      <span className="font-semibold">{company.name}</span>
                      <span className="text-sm text-muted-foreground">
                        {company.slug} · {label(company.role)}
                      </span>
                    </RowButton>
                  ))}
                </List>
              )}
            </Card>
            <Card title="Assinatura">
              {detail.subscription === null ? (
                <p className="text-sm text-muted-foreground">
                  Sem assinatura (ou cobrança desligada).
                </p>
              ) : (
                <Facts
                  items={[
                    [
                      'Plano',
                      `${label(detail.subscription.plan)} (${label(detail.subscription.cycle)})`,
                    ],
                    [
                      'Estado',
                      `${label(detail.subscription.state)} · ${label(detail.subscription.access)}`,
                    ],
                    ['Fim do período', formatDate(detail.subscription.periodEnd)],
                  ]}
                />
              )}
            </Card>
          </>
        )}
      </div>
    </>
  );
}

/** Contas (`GET /platform/accounts`): e-mail sempre mascarado na lista. */
export function AccountsScreen() {
  const [status, setStatus] = useState<StatusFilter>('');
  const [verified, setVerified] = useState<VerifiedFilter>('');
  const [selected, setSelected] = useState<AccountListItem | undefined>(undefined);
  const page = usePaged(
    (api, cursor) =>
      api.get(
        `/platform/accounts${query({
          status: status === '' ? undefined : status,
          verified: verified === '' ? undefined : verified,
          cursor: cursor ?? undefined,
        })}`,
        accountPageSchema,
      ),
    `${status}|${verified}`,
  );

  if (selected !== undefined)
    return (
      <AccountDetailPanel
        key={selected.id}
        account={selected}
        onBack={() => setSelected(undefined)}
      />
    );

  return (
    <>
      <PageHeader title="Contas" onRefresh={page.reload} busy={page.loading} />
      <div className="mb-4 flex flex-wrap gap-3">
        <Select<StatusFilter>
          label="Estado"
          value={status}
          onChange={setStatus}
          options={[
            ['', 'Todas'],
            ['active', 'Ativas'],
            ['disabled', 'Desativadas'],
          ]}
        />
        <Select<VerifiedFilter>
          label="E-mail"
          value={verified}
          onChange={setVerified}
          options={[
            ['', 'Todos'],
            ['true', 'Confirmado'],
            ['false', 'Não confirmado'],
          ]}
        />
      </div>
      {page.error === undefined ? null : <Alert>{errorMessage(page.error)}</Alert>}
      {page.items === undefined || page.items === null ? (
        page.loading ? (
          <Loading />
        ) : null
      ) : page.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma conta.</p>
      ) : (
        <>
          <List label="Contas">
            {page.items.map((account) => (
              <RowButton
                key={account.id}
                ariaLabel={`Abrir conta ${account.emailMasked}`}
                onOpen={() => setSelected(account)}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{account.emailMasked}</span>
                  <Badge tone={account.status === 'DISABLED' ? 'bad' : 'neutral'}>
                    {label(account.status)}
                  </Badge>
                  <Badge tone={account.verified ? 'good' : 'neutral'}>
                    {account.verified ? 'Confirmada' : 'Não confirmada'}
                  </Badge>
                </span>
                <span className="flex flex-wrap gap-x-4 text-sm text-muted-foreground">
                  <span>Criada em {formatDate(account.createdAt)}</span>
                  <span>Empresas: {formatCount(account.companies)}</span>
                  <span>Assinatura: {account.hasSubscription ? 'sim' : 'não'}</span>
                </span>
              </RowButton>
            ))}
          </List>
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
