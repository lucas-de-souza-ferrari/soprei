import { useState } from 'react';
import { query } from '../api';
import { usePaged } from '../admin-context';
import { companyPageSchema, type AttentionFilter } from '../contracts';
import { errorMessage } from '../format';
import { Alert, Button, Card, Loading, PageHeader } from '../ui';
import { CompanyRows } from './CompaniesScreen';

function Section({
  title,
  attention,
}: {
  readonly title: string;
  readonly attention: AttentionFilter;
}) {
  const page = usePaged(
    (api, cursor) =>
      api.get(
        `/platform/companies${query({ attention, cursor: cursor ?? undefined, limit: '30' })}`,
        companyPageSchema,
      ),
    attention,
  );
  return (
    <Card title={title}>
      {page.error === undefined ? null : <Alert>{errorMessage(page.error)}</Alert>}
      {page.items === undefined || page.items === null ? (
        page.loading ? (
          <Loading />
        ) : null
      ) : (
        <CompanyRows items={page.items} from={{ name: 'channel' }} label={title} />
      )}
      {page.hasMore ? (
        <div className="mt-3">
          <Button onClick={page.more} disabled={page.loading}>
            Carregar mais
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * Canal: empresas com token recusado pela Meta e com token que vence em até 7 dias (a lista de empresas
 * com o filtro de atenção; ver contracts.ts, item 4). "Atualizar" remonta as duas seções.
 */
export function ChannelScreen() {
  const [round, setRound] = useState(0);
  return (
    <>
      <PageHeader title="Canal" onRefresh={() => setRound((n) => n + 1)} />
      <div key={round} className="flex flex-col gap-4">
        <Section title="Token inválido" attention="token_invalid" />
        <Section title="Token vencendo em até 7 dias" attention="token_expiring" />
      </div>
    </>
  );
}
