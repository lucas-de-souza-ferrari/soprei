import { useState } from 'react';
import { query } from '../api';
import { usePaged } from '../admin-context';
import { noticePageSchema, orderPageSchema } from '../contracts';
import { errorMessage, formatCents, formatDate, formatDateTime, label } from '../format';
import { Alert, Badge, Button, Card, List, Loading, PageHeader, Row, Select } from '../ui';

type OrderStatus = '' | 'PENDING' | 'PAID' | 'EXPIRED' | 'FAILED';
type OrderKind = '' | 'NEW' | 'RENEWAL' | 'UPGRADE' | 'EXTRA_PACK';

const ORDER_STATUSES: readonly (readonly [OrderStatus, string])[] = [
  ['', 'Todos'],
  ...(['PENDING', 'PAID', 'EXPIRED', 'FAILED'] as const).map((key) => [key, label(key)] as const),
];
const ORDER_KINDS: readonly (readonly [OrderKind, string])[] = [
  ['', 'Todos'],
  ...(['NEW', 'RENEWAL', 'UPGRADE', 'EXTRA_PACK'] as const).map(
    (key) => [key, label(key)] as const,
  ),
];

function Disabled() {
  return <p className="text-sm text-muted-foreground">Cobrança desligada.</p>;
}

/** Cobrança: pedidos (`/platform/billing/orders`) e avisos enviados (`/platform/billing/notices`). */
export function BillingScreen() {
  const [status, setStatus] = useState<OrderStatus>('');
  const [kind, setKind] = useState<OrderKind>('');
  const orders = usePaged(
    (api, cursor) =>
      api.get(
        `/platform/billing/orders${query({
          status: status === '' ? undefined : status,
          kind: kind === '' ? undefined : kind,
          cursor: cursor ?? undefined,
        })}`,
        orderPageSchema,
      ),
    `${status}|${kind}`,
  );
  const notices = usePaged(
    (api, cursor) =>
      api.get(
        `/platform/billing/notices${query({ cursor: cursor ?? undefined })}`,
        noticePageSchema,
      ),
    'notices',
  );

  return (
    <>
      <PageHeader
        title="Cobrança"
        onRefresh={() => {
          orders.reload();
          notices.reload();
        }}
        busy={orders.loading || notices.loading}
      />
      <div className="flex flex-col gap-4">
        <Card title="Pedidos">
          <div className="mb-3 flex flex-wrap gap-3">
            <Select<OrderStatus>
              label="Situação"
              value={status}
              onChange={setStatus}
              options={ORDER_STATUSES}
            />
            <Select<OrderKind> label="Tipo" value={kind} onChange={setKind} options={ORDER_KINDS} />
          </div>
          {orders.error === undefined ? null : <Alert>{errorMessage(orders.error)}</Alert>}
          {orders.items === undefined ? (
            orders.loading ? (
              <Loading />
            ) : null
          ) : orders.items === null ? (
            <Disabled />
          ) : orders.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum pedido.</p>
          ) : (
            <List label="Pedidos">
              {orders.items.map((order) => (
                <Row key={order.id}>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{formatCents(order.amountCents)}</span>
                    <Badge
                      tone={
                        order.status === 'PAID'
                          ? 'good'
                          : order.status === 'FAILED'
                            ? 'bad'
                            : 'neutral'
                      }
                    >
                      {label(order.status)}
                    </Badge>
                    <span className="text-sm">{label(order.kind)}</span>
                  </span>
                  <span className="flex flex-wrap gap-x-4 text-sm text-muted-foreground">
                    <span>Criado em {formatDateTime(order.createdAt)}</span>
                    <span>Pago em {formatDateTime(order.paidAt)}</span>
                    <span>Expira em {formatDateTime(order.expiresAt)}</span>
                    <span>
                      Período {formatDate(order.periodStart)} a {formatDate(order.periodEnd)}
                    </span>
                    <span>Meio: {order.captureMethod ?? '—'}</span>
                  </span>
                </Row>
              ))}
            </List>
          )}
          {orders.hasMore ? (
            <div className="mt-3">
              <Button onClick={orders.more} disabled={orders.loading}>
                Carregar mais pedidos
              </Button>
            </div>
          ) : null}
        </Card>
        <Card title="Avisos enviados">
          {notices.error === undefined ? null : <Alert>{errorMessage(notices.error)}</Alert>}
          {notices.items === undefined ? (
            notices.loading ? (
              <Loading />
            ) : null
          ) : notices.items === null ? (
            <Disabled />
          ) : notices.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum aviso.</p>
          ) : (
            <List label="Avisos enviados">
              {notices.items.map((notice, index) => (
                <Row key={`${notice.createdAt}-${String(index)}`}>
                  <span className="font-semibold">{label(notice.kind)}</span>
                  <span className="flex flex-wrap gap-x-4 text-sm text-muted-foreground">
                    <span>Enviado em {formatDateTime(notice.createdAt)}</span>
                    <span>Janela {formatDate(notice.windowStart)}</span>
                  </span>
                </Row>
              ))}
            </List>
          )}
          {notices.hasMore ? (
            <div className="mt-3">
              <Button onClick={notices.more} disabled={notices.loading}>
                Carregar mais avisos
              </Button>
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
