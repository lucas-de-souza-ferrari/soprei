import { useState } from 'react';
import { ArrowLeft, Eye } from 'lucide-react';
import { ApiError } from '../api';
import { useAdmin, useLoad, type View } from '../admin-context';
import { accountDetailSchema, accountEmailSchema } from '../contracts';
import { errorMessage, formatCount, formatDateTime, label } from '../format';
import { Alert, Button, Card, Facts, List, Loading, PageHeader, RowButton } from '../ui';
import { subscriptionFacts } from './subscription-facts';

/**
 * Detalhe de uma conta (spec 045, D3). Abre por `GET /platform/accounts/:accountId`, que traz só o e-mail
 * mascarado e não grava nada (abrir a conta a partir da empresa não conta como leitura do e-mail). O
 * e-mail completo só vem do botão "Mostrar e-mail" (`GET .../email`), leitura que o servidor audita; ele
 * fica só no estado desta tela, nunca no endereço, no título nem no armazenamento do navegador.
 */
export function AccountDetailScreen({
  accountId,
  from,
}: {
  readonly accountId: string;
  readonly from: View;
}) {
  const { api, expire, navigate } = useAdmin();
  const { data, error, loading, reload } = useLoad(
    (client) =>
      client.get(`/platform/accounts/${encodeURIComponent(accountId)}`, accountDetailSchema),
    accountId,
  );
  const [email, setEmail] = useState<string | undefined>(undefined);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<unknown>(undefined);
  const self: View = { name: 'account', accountId, from };

  async function reveal() {
    setRevealing(true);
    setRevealError(undefined);
    try {
      const result = await api.get(
        `/platform/accounts/${encodeURIComponent(accountId)}/email`,
        accountEmailSchema,
      );
      setEmail(result.email);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) return expire();
      setRevealError(failure);
    } finally {
      setRevealing(false);
    }
  }

  return (
    <>
      <div className="mb-2">
        <Button variant="ghost" onClick={() => navigate(from)}>
          <ArrowLeft aria-hidden className="size-4" />
          Voltar
        </Button>
      </div>
      <PageHeader title="Conta" onRefresh={reload} busy={loading} />
      {error === undefined ? null : <Alert>{errorMessage(error)}</Alert>}
      {data === undefined ? (
        loading ? (
          <Loading />
        ) : null
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <Facts
              items={[
                [
                  'E-mail',
                  <span className="break-all" key="e">
                    {email ?? data.emailMasked}
                  </span>,
                ],
                ['Estado', label(data.status)],
                ['E-mail confirmado', data.verified ? 'Sim' : 'Não'],
                ['Criada em', formatDateTime(data.createdAt)],
                ['Empresas', formatCount(data.companies.length)],
              ]}
            />
            {email === undefined ? (
              <div className="mt-3 flex flex-col gap-1">
                <div>
                  <Button onClick={() => void reveal()} disabled={revealing}>
                    <Eye aria-hidden className="size-4" />
                    Mostrar e-mail
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  A leitura do e-mail completo fica registrada na auditoria.
                </p>
              </div>
            ) : null}
            {revealError === undefined ? null : <Alert>{errorMessage(revealError)}</Alert>}
          </Card>
          <Card title="Empresas da conta">
            {data.companies.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhuma empresa.</p>
            ) : (
              <List label="Empresas da conta">
                {data.companies.map((company) => (
                  <RowButton
                    key={company.id}
                    ariaLabel={`Abrir ${company.name}`}
                    onOpen={() => navigate({ name: 'company', companyId: company.id, from: self })}
                  >
                    <span className="font-semibold">{company.name}</span>
                    <span className="text-sm text-muted-foreground">
                      {company.slug} · {label(company.role)}
                      {company.membershipStatus === 'DISABLED' ? ' (vínculo desativado)' : ''}
                      {company.status === 'SUSPENDED' ? ' · empresa suspensa' : ''}
                    </span>
                  </RowButton>
                ))}
              </List>
            )}
          </Card>
          <Card title="Assinatura">
            {!data.billingEnabled ? (
              <p className="text-sm text-muted-foreground">Cobrança desligada.</p>
            ) : data.subscription === null ? (
              <p className="text-sm text-muted-foreground">Sem assinatura.</p>
            ) : (
              <Facts items={subscriptionFacts(data.subscription)} />
            )}
          </Card>
        </div>
      )}
    </>
  );
}
