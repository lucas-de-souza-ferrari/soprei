import { useState } from 'react';
import { query } from '../api';
import { useAdmin, usePaged, type View } from '../admin-context';
import { accountPageSchema, type AccountStatusFilter, type VerifiedFilter } from '../contracts';
import { errorMessage, formatCount, formatDate, label } from '../format';
import { Alert, Badge, Button, List, Loading, PageHeader, RowButton, Select } from '../ui';

/**
 * Contas (`GET /platform/accounts`): e-mail sempre mascarado na lista. Abrir uma conta leva ao detalhe
 * (`AccountDetailScreen`), também mascarado; o e-mail completo só pelo "Mostrar e-mail" de lá.
 */
export function AccountsScreen({
  initialStatus,
  initialVerified,
}: {
  readonly initialStatus: AccountStatusFilter | undefined;
  readonly initialVerified: VerifiedFilter | undefined;
}) {
  const { navigate } = useAdmin();
  const [status, setStatus] = useState<AccountStatusFilter | ''>(initialStatus ?? '');
  const [verified, setVerified] = useState<VerifiedFilter | ''>(initialVerified ?? '');
  const from: View = {
    name: 'accounts',
    ...(status === '' ? {} : { status }),
    ...(verified === '' ? {} : { verified }),
  };
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

  return (
    <>
      <PageHeader title="Contas" onRefresh={page.reload} busy={page.loading} />
      <div className="mb-4 flex flex-wrap gap-3">
        <Select<AccountStatusFilter | ''>
          label="Estado"
          value={status}
          onChange={setStatus}
          options={[
            ['', 'Todas'],
            ['active', 'Ativas'],
            ['disabled', 'Desativadas'],
          ]}
        />
        <Select<VerifiedFilter | ''>
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
                onOpen={() => navigate({ name: 'account', accountId: account.id, from })}
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
