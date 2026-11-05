import { AlertTriangle, CheckCircle2, PackageX } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { Alert, AlertContent, AlertDescription, AlertIcon } from '../components/motion/alert';
import { Button } from '../components/motion/button';
import { Input } from '../components/motion/input';
import { Loader } from '../components/motion/loader';
import { ConfirmDialog } from './ConfirmDialog';
import {
  INVENTORY_INVALID_MESSAGE,
  INVENTORY_STALE_MESSAGE,
  inventoryApi,
  inventoryMessageOf,
  type Movement,
  type Product,
} from './inventory-api';
import {
  ADJUST_KINDS,
  type AdjustKind,
  deltaFor,
  productFormProblem,
  type ProductFormValues,
  REASON_LABELS,
  STATUS_LABELS,
  stockStatus,
  type StockStatus,
} from './inventory-rules';
import { formatMoney, moneyInputValue, parseMoney } from './money';
import { formatDateTime } from './team-rules';
import { Modal } from './Modal';
import type { PageProps } from './PersonaPage';

type Notice = { tone: 'error' | 'success'; text: string } | null;
type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; product: Product }
  | { kind: 'adjust'; product: Product }
  | { kind: 'history'; product: Product }
  | null;

export const INVENTORY_SAVE_FAILED = 'Não foi possível salvar agora. Tente de novo.';
const OWN_MESSAGE_STATUSES = [403, 429, 502, 503];
const FIELD_CLASS =
  'h-12 w-full rounded-xl border border-input bg-background px-3 text-base text-foreground focus-visible:outline-3 focus-visible:outline-ring';

const STATUS_ICONS: Readonly<Record<StockStatus, ReactNode>> = {
  out: <PackageX aria-hidden="true" className="size-4" />,
  low: <AlertTriangle aria-hidden="true" className="size-4" />,
  ok: <CheckCircle2 aria-hidden="true" className="size-4" />,
};
const STATUS_COLORS: Readonly<Record<StockStatus, string>> = {
  out: 'text-destructive',
  low: 'text-primary',
  ok: 'text-(--color-success)',
};

/** Situação com texto e ícone (nunca só cor): o par de cor de cada selo está no teste de contraste. */
function StatusBadge({ product }: { product: Product }) {
  const status = stockStatus(product.quantity, product.lowStockThreshold);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[status]}`}
    >
      {STATUS_ICONS[status]}
      {STATUS_LABELS[status]}
    </span>
  );
}

function Chip({ children }: { children: string }) {
  return (
    <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {children}
    </span>
  );
}

function Problem({ text }: { text: string | null }) {
  return (
    <div aria-live="polite">
      {text !== null && (
        <Alert variant="destructive">
          <AlertIcon />
          <AlertContent>
            <AlertDescription className="text-inherit">{text}</AlertDescription>
          </AlertContent>
        </Alert>
      )}
    </div>
  );
}

interface ProductFormProps {
  readonly product: Product | null;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onSubmit: (values: ProductFormValues) => void;
}

/** Criar (SKU e quantidade inicial) ou editar (nome, descrição, preço e alerta) um produto. */
function ProductForm({ product, busy, problem, onSubmit }: ProductFormProps) {
  const creating = product === null;
  const [values, setValues] = useState<ProductFormValues>({
    sku: '',
    name: product?.name ?? '',
    description: product?.description ?? '',
    price: product === null ? '' : moneyInputValue(product.priceCents),
    quantity: '',
    threshold:
      product === null || product.lowStockThreshold === 0 ? '' : String(product.lowStockThreshold),
  });
  const [local, setLocal] = useState<string | null>(null);
  const set = (key: keyof ProductFormValues) => (value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setLocal(null);
  };
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const found = productFormProblem(values, creating);
        if (found !== null) {
          setLocal(found);
          return;
        }
        onSubmit(values);
      }}
    >
      <Problem text={local ?? problem} />
      {creating && <Input label="SKU" value={values.sku} maxLength={40} onChange={set('sku')} />}
      <Input label="Nome" value={values.name} maxLength={120} onChange={set('name')} />
      <Input
        label="Descrição (opcional)"
        value={values.description}
        maxLength={500}
        onChange={set('description')}
      />
      <Input
        label="Preço (R$)"
        inputMode="decimal"
        value={values.price}
        onChange={set('price')}
        placeholder="59,90"
      />
      {creating && (
        <Input
          label="Quantidade inicial"
          inputMode="numeric"
          value={values.quantity}
          onChange={set('quantity')}
        />
      )}
      <Input
        label="Avisar quando chegar a (opcional)"
        inputMode="numeric"
        value={values.threshold}
        onChange={set('threshold')}
      />
      {!creating && (
        <p className="m-0 text-xs text-muted-foreground">
          A quantidade só muda em &quot;Ajustar&quot;, para ficar no histórico.
        </p>
      )}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Aguarde…' : creating ? 'Criar produto' : 'Salvar'}
        </Button>
      </div>
    </form>
  );
}

interface AdjustFormProps {
  readonly product: Product;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onSubmit: (delta: number, reason: AdjustKind) => void;
}

function AdjustForm({ product, busy, problem, onSubmit }: AdjustFormProps) {
  const [kind, setKind] = useState<AdjustKind>('ENTRY');
  const [amount, setAmount] = useState('');
  const [local, setLocal] = useState<string | null>(null);
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const delta = deltaFor(kind, amount);
        if (delta === null) {
          setLocal(
            kind === 'COUNT_CORRECTION'
              ? 'Informe um número inteiro diferente de zero (pode ter sinal).'
              : 'Informe um número inteiro maior que zero.',
          );
          return;
        }
        onSubmit(delta, kind);
      }}
    >
      <Problem text={local ?? problem} />
      <p className="m-0 text-sm text-muted-foreground">
        Quantidade atual de <strong className="text-foreground">{product.name}</strong>:{' '}
        {product.quantity.toLocaleString('pt-BR')}.
      </p>
      <div className="grid gap-1.5">
        <label htmlFor="tipo-de-ajuste" className="px-1 text-sm font-medium">
          Tipo
        </label>
        <select
          id="tipo-de-ajuste"
          className={FIELD_CLASS}
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as AdjustKind);
            setLocal(null);
          }}
        >
          {ADJUST_KINDS.map((item) => (
            <option key={item} value={item}>
              {REASON_LABELS[item]}
            </option>
          ))}
        </select>
      </div>
      <Input
        label={kind === 'COUNT_CORRECTION' ? 'Diferença (ex.: -3 ou 5)' : 'Quantidade'}
        inputMode={kind === 'COUNT_CORRECTION' ? 'text' : 'numeric'}
        value={amount}
        onChange={(value) => {
          setAmount(value);
          setLocal(null);
        }}
      />
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Aguarde…' : 'Registrar ajuste'}
        </Button>
      </div>
    </form>
  );
}

/**
 * Estoque da empresa (spec 026, E2). Preço digitado em reais (vírgula) e convertido a centavos no
 * navegador. A quantidade só muda em "Ajustar" (entrada, saída, perda ou correção), que fica no
 * histórico. SKU, nome, descrição e preço só vivem no estado desta tela (nada em URL, armazenamento
 * do navegador nem log); resposta que chega depois de trocar de empresa é descartada.
 */
export function EstoquePage({ companyId, settle }: PageProps) {
  const [items, setItems] = useState<Product[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dialogProblem, setDialogProblem] = useState<string | null>(null);
  const [toggle, setToggle] = useState<Product | null>(null);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [movementsNext, setMovementsNext] = useState<string | null>(null);
  const [movementsLoaded, setMovementsLoaded] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    setLoadError(null);
    const stamp = ++generation.current;
    inventoryApi
      .products(companyId, { q: applied })
      .then((page) => {
        if (stamp !== generation.current) return;
        setItems([...page.items]);
        setNext(page.nextCursor);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (stamp !== generation.current) return;
        const text = settle(error);
        if (text !== null) setLoadError(text);
      });
    return () => {
      generation.current++;
    };
  }, [companyId, settle, attempt, applied]);

  const failure = useCallback(
    (error: unknown, inDialog: boolean): void => {
      const own = inventoryMessageOf(error);
      const text = own ?? settle(error);
      if (text === null) return;
      const known =
        own !== null || (error instanceof ApiError && OWN_MESSAGE_STATUSES.includes(error.status));
      const shown = known ? text : INVENTORY_SAVE_FAILED;
      if (inDialog) setDialogProblem(shown);
      else setNotice({ tone: 'error', text: shown });
    },
    [settle],
  );

  /** Troca o produto na lista pelo que o servidor devolveu. */
  const replace = (product: Product): void => {
    setItems((current) => current.map((item) => (item.id === product.id ? product : item)));
  };

  const run = async (work: () => Promise<void>, inDialog: boolean): Promise<void> => {
    const stamp = ++generation.current;
    setBusy(true);
    setNotice(null);
    setDialogProblem(null);
    try {
      await work();
    } catch (error) {
      if (stamp !== generation.current) return;
      if (error instanceof ApiError && error.status === 404) {
        setItems((current) => current);
        setDialog(null);
        setNotice({ tone: 'error', text: INVENTORY_STALE_MESSAGE });
        setAttempt((value) => value + 1);
      } else {
        failure(error, inDialog);
      }
    } finally {
      if (stamp === generation.current) setBusy(false);
    }
  };

  const save = (values: ProductFormValues, product: Product | null): Promise<void> =>
    run(async () => {
      const priceCents = parseMoney(values.price);
      if (priceCents === null) {
        setDialogProblem(INVENTORY_INVALID_MESSAGE);
        return;
      }
      const threshold = values.threshold.trim() === '' ? 0 : Number(values.threshold);
      if (product === null) {
        const created = await inventoryApi.create(companyId, {
          sku: values.sku.trim().toUpperCase(),
          name: values.name.trim(),
          description: values.description.trim(),
          priceCents,
          quantity: Number(values.quantity),
          lowStockThreshold: threshold,
        });
        setItems((current) => [created, ...current]);
        setNotice({ tone: 'success', text: 'Produto criado.' });
      } else {
        const updated = await inventoryApi.update(companyId, product.id, {
          name: values.name.trim(),
          description: values.description.trim(),
          priceCents,
          lowStockThreshold: threshold,
        });
        replace(updated);
        setNotice({ tone: 'success', text: 'Produto atualizado.' });
      }
      setDialog(null);
    }, true);

  const adjust = (product: Product, delta: number, reason: AdjustKind): Promise<void> =>
    run(async () => {
      const result = await inventoryApi.adjust(companyId, product.id, { delta, reason });
      replace(result.product);
      setNotice({
        tone: 'success',
        text: `Estoque ajustado: ${result.product.quantity.toLocaleString('pt-BR')} unidades.`,
      });
      setDialog(null);
    }, true);

  const setActive = (product: Product, active: boolean): Promise<void> =>
    run(async () => {
      replace(await inventoryApi.update(companyId, product.id, { active }));
      setNotice({
        tone: 'success',
        text: active ? 'Produto reativado.' : 'Produto desativado. A IA não o usa mais.',
      });
      setToggle(null);
    }, false);

  const loadMore = (): Promise<void> =>
    run(async () => {
      if (next === null) return;
      const page = await inventoryApi.products(companyId, { q: applied, cursor: next });
      setItems((current) => [...current, ...page.items]);
      setNext(page.nextCursor);
    }, false);

  const openHistory = (product: Product): void => {
    setMovements([]);
    setMovementsNext(null);
    setMovementsLoaded(false);
    setDialogProblem(null);
    setDialog({ kind: 'history', product });
    void loadMovements(product, undefined);
  };

  const loadMovements = async (product: Product, cursor: string | undefined): Promise<void> => {
    const stamp = generation.current;
    try {
      const page = await inventoryApi.movements(companyId, product.id, cursor);
      if (stamp !== generation.current) return;
      setMovements((current) =>
        cursor === undefined ? [...page.items] : [...current, ...page.items],
      );
      setMovementsNext(page.nextCursor);
      setMovementsLoaded(true);
    } catch (error) {
      if (stamp !== generation.current) return;
      failure(error, true);
      setMovementsLoaded(true);
    }
  };

  if (loadError !== null) {
    return (
      <div className="grid gap-4">
        <Problem text={loadError} />
        <div>
          <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
            Tentar de novo
          </Button>
        </div>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="grid place-items-center gap-3 py-10 text-sm text-muted-foreground">
        <Loader variant="spinner" size={28} label="Carregando o estoque" />
        <span aria-hidden="true">Carregando o estoque…</span>
      </div>
    );
  }

  return (
    <div className="grid gap-5">
      <p className="m-0 rounded-2xl border border-border bg-muted p-3 text-sm text-foreground">
        A IA lê o preço e a quantidade destes produtos para responder, mas nunca altera o estoque. O
        estoque é manual: mantenha-o em dia (a resposta informa a hora do dado).
      </p>
      <div aria-live="polite">
        {notice && (
          <Alert variant={notice.tone === 'error' ? 'destructive' : 'success'}>
            <AlertIcon />
            <AlertContent>
              <AlertDescription className="text-inherit">{notice.text}</AlertDescription>
            </AlertContent>
          </Alert>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <form
          className="flex min-w-0 flex-1 flex-wrap items-end gap-2"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied(search.trim());
          }}
        >
          <div className="min-w-48 flex-1">
            <Input
              label="Buscar por nome ou SKU"
              value={search}
              maxLength={60}
              onChange={setSearch}
            />
          </div>
          <Button type="submit" variant="outline">
            Buscar
          </Button>
        </form>
        <Button
          onClick={() => {
            setDialogProblem(null);
            setDialog({ kind: 'create' });
          }}
        >
          Novo produto
        </Button>
      </div>

      {items.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">
          {applied === '' ? 'Nenhum produto ainda. Crie o primeiro.' : 'Nenhum produto encontrado.'}
        </p>
      ) : (
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">Produtos do estoque</caption>
          <thead className="hidden md:table-header-group">
            <tr className="border-b border-border text-muted-foreground">
              <th scope="col" className="px-2 py-2 font-medium">
                SKU
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Nome
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Preço
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Quantidade
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Situação
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Ações
              </th>
            </tr>
          </thead>
          <tbody className="block md:table-row-group">
            {items.map((product) => (
              <tr
                key={product.id}
                className={`mb-3 block rounded-2xl border border-border bg-card p-3 text-card-foreground md:mb-0 md:table-row md:rounded-none md:border-0 md:border-b md:bg-transparent md:p-0 ${product.active ? '' : 'opacity-70'}`}
              >
                <td className="block py-0.5 md:table-cell md:px-2 md:py-2">
                  <span className="text-muted-foreground md:hidden">SKU: </span>
                  <span className="font-mono">{product.sku}</span>
                </td>
                <td className="block py-0.5 [overflow-wrap:anywhere] md:table-cell md:px-2 md:py-2">
                  <strong>{product.name}</strong> {product.isSample && <Chip>Exemplo</Chip>}{' '}
                  {!product.active && <Chip>Desativado</Chip>}
                </td>
                <td className="block py-0.5 md:table-cell md:px-2 md:py-2">
                  <span className="text-muted-foreground md:hidden">Preço: </span>
                  {formatMoney(product.priceCents)}
                </td>
                <td className="block py-0.5 md:table-cell md:px-2 md:py-2">
                  <span className="text-muted-foreground md:hidden">Quantidade: </span>
                  {product.quantity.toLocaleString('pt-BR')}
                </td>
                <td className="block py-0.5 md:table-cell md:px-2 md:py-2">
                  <StatusBadge product={product} />
                </td>
                <td className="block py-1 md:table-cell md:px-2 md:py-2">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      aria-label={`Ajustar a quantidade de ${product.name}`}
                      onClick={() => {
                        setDialogProblem(null);
                        setDialog({ kind: 'adjust', product });
                      }}
                    >
                      Ajustar
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      aria-label={`Editar ${product.name}`}
                      onClick={() => {
                        setDialogProblem(null);
                        setDialog({ kind: 'edit', product });
                      }}
                    >
                      Editar
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      aria-label={`Histórico de ${product.name}`}
                      onClick={() => openHistory(product)}
                    >
                      Histórico
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      aria-label={`${product.active ? 'Desativar' : 'Reativar'} ${product.name}`}
                      onClick={() => {
                        if (product.active) setToggle(product);
                        else void setActive(product, true);
                      }}
                    >
                      {product.active ? 'Desativar' : 'Reativar'}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next !== null && (
        <div>
          <Button variant="outline" disabled={busy} onClick={() => void loadMore()}>
            Carregar mais
          </Button>
        </div>
      )}

      <Modal open={dialog?.kind === 'create'} title="Novo produto" onClose={() => setDialog(null)}>
        <ProductForm
          product={null}
          busy={busy}
          problem={dialogProblem}
          onSubmit={(values) => void save(values, null)}
        />
      </Modal>
      <Modal open={dialog?.kind === 'edit'} title="Editar produto" onClose={() => setDialog(null)}>
        {dialog?.kind === 'edit' && (
          <ProductForm
            key={dialog.product.id}
            product={dialog.product}
            busy={busy}
            problem={dialogProblem}
            onSubmit={(values) => void save(values, dialog.product)}
          />
        )}
      </Modal>
      <Modal
        open={dialog?.kind === 'adjust'}
        title="Ajustar quantidade"
        onClose={() => setDialog(null)}
      >
        {dialog?.kind === 'adjust' && (
          <AdjustForm
            key={dialog.product.id}
            product={dialog.product}
            busy={busy}
            problem={dialogProblem}
            onSubmit={(delta, reason) => void adjust(dialog.product, delta, reason)}
          />
        )}
      </Modal>
      <Modal
        open={dialog?.kind === 'history'}
        title="Histórico de movimentos"
        onClose={() => setDialog(null)}
      >
        <div className="grid gap-3">
          <Problem text={dialogProblem} />
          {!movementsLoaded ? (
            <p className="m-0 text-sm text-muted-foreground">Carregando…</p>
          ) : movements.length === 0 ? (
            <p className="m-0 text-sm text-muted-foreground">Nenhum movimento.</p>
          ) : (
            <ul className="m-0 grid list-none gap-2 p-0">
              {movements.map((movement) => (
                <li
                  key={movement.id}
                  className="grid gap-0.5 rounded-xl border border-border bg-background p-3 text-sm"
                >
                  <span>
                    <strong>{REASON_LABELS[movement.reason]}</strong>:{' '}
                    {movement.delta > 0 ? '+' : ''}
                    {movement.delta.toLocaleString('pt-BR')} (ficou com{' '}
                    {movement.quantityAfter.toLocaleString('pt-BR')})
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(movement.createdAt)}
                    {movement.byMe ? ' · por você' : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {movementsNext !== null && dialog?.kind === 'history' && (
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadMovements(dialog.product, movementsNext)}
              >
                Carregar mais
              </Button>
            </div>
          )}
        </div>
      </Modal>
      <ConfirmDialog
        request={
          toggle === null
            ? null
            : {
                title: 'Desativar o produto?',
                text: `"${toggle.name}" deixa de ser usado pela IA. O histórico continua e você pode reativá-lo.`,
                confirmLabel: 'Desativar',
              }
        }
        busy={busy}
        onConfirm={() => {
          if (toggle !== null) void setActive(toggle, false);
        }}
        onCancel={() => setToggle(null)}
      />
    </div>
  );
}
