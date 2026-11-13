import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertContent, AlertDescription, AlertIcon } from '../components/motion/alert';
import { Button } from '../components/motion/button';
import { Loader } from '../components/motion/loader';
import {
  type Billing,
  billingApi,
  billingFailure,
  type CatalogPlan,
  CYCLES,
  type Quote,
  type Selection,
} from './billing-api';
import {
  canCancel,
  canCheckOrder,
  canReactivate,
  type CheckoutReturn,
  CYCLE_LABELS,
  CYCLE_NOTES,
  daysLeft,
  defaultSelection,
  describeSelection,
  exhaustedBanner,
  formatCount,
  formatDate,
  META_ESTIMATE_NOTE,
  metaEstimateCents,
  ORDER_KIND_LABELS,
  ORDER_STATUS_LABELS,
  perReplyText,
  plural,
  priceOf,
  QUOTA_TEXT,
  quotaLevel,
  quoteView,
  safeCheckoutUrl,
  samePlan,
  stateBanner,
  usagePercent,
  whatsappNotice,
  type Tone,
} from './billing-rules';
import { ConfirmDialog } from './ConfirmDialog';
import { EnterpriseCard } from '../contact/EnterpriseCard';
import { SectionTabs } from './SectionTabs';
import { formatMoney } from './money';
import { RetryAlert } from './RetryAlert';

export interface SubscriptionPageProps {
  /** Volta do checkout (a query do retorno, já validada): só dispara o "Já paguei", nunca concede. */
  readonly checkoutReturn: CheckoutReturn | null;
  readonly onReturnConsumed: () => void;
  /** A assinatura mudou (pagamento confirmado, troca, cancelamento): o site relê o acesso e o menu. */
  readonly onChanged: () => void;
  /** 401: a sessão acabou; o site volta ao login. */
  readonly onSession: () => void;
  /** Leva à criação de empresa (a conta sem assinatura começa o teste gratuito ao criar a primeira). */
  readonly onOpenCompanies: () => void;
  /** Intervalo entre as reconsultas depois da volta do checkout (injetável nos testes). */
  readonly pollMs?: number;
}

type Notice = { tone: Tone; text: string } | null;
type Busy = 'pay' | 'schedule' | 'cancel' | 'undo' | 'reactivate' | 'check' | null;
type Waiting = {
  readonly orderId: string;
  readonly transactionNsu?: string | undefined;
  readonly slug?: string | undefined;
};

const POLL_DEFAULT_MS = 5_000;
const POLL_MAX_ATTEMPTS = 12;

const ALERT_VARIANT = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'destructive',
} as const;

function ToneAlert({ tone, title, text }: { tone: Tone; title?: string; text: string }) {
  return (
    <Alert variant={ALERT_VARIANT[tone]}>
      <AlertIcon />
      <AlertContent>
        {title !== undefined && <p className="m-0 font-semibold">{title}</p>}
        <AlertDescription className="text-inherit">{text}</AlertDescription>
      </AlertContent>
    </Alert>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="grid min-w-0 gap-3 rounded-2xl border border-border bg-card p-4 text-card-foreground sm:p-5"
    >
      <h2 id={id} className="m-0 text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function UsageBar({
  id,
  label,
  used,
  limit,
  unit,
}: {
  id: string;
  label: string;
  used: number;
  limit: number;
  unit: string;
}) {
  const percent = usagePercent(used, limit);
  const level = quotaLevel(used, limit);
  const value = `${formatCount(used)} de ${formatCount(limit)} ${unit} (${String(percent)}%)`;
  return (
    <div className="grid gap-1.5" data-testid={`uso-${id}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span id={`${id}-label`} className="font-medium">
          {label}
        </span>
        <span className="text-muted-foreground">{value}</span>
      </div>
      <div
        role="progressbar"
        aria-labelledby={`${id}-label`}
        aria-valuemin={0}
        aria-valuemax={Math.max(limit, 1)}
        aria-valuenow={Math.min(used, Math.max(limit, 1))}
        aria-valuetext={value}
        className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={`h-full rounded-full ${level === 'full' ? 'bg-destructive' : 'bg-primary'}`}
          style={{ width: `${String(percent)}%` }}
        />
      </div>
      {level !== 'ok' && (
        <p
          className={`m-0 text-sm font-medium ${level === 'full' ? 'text-destructive' : 'text-primary'}`}
          data-testid={`alerta-${id}`}
        >
          {QUOTA_TEXT[level]}
        </p>
      )}
    </div>
  );
}

/**
 * Tela de Assinatura (spec 031, E4; spec 040, E2: só respostas, sem a cota de tokens): visível só à conta titular e só com a cobrança ligada. Todo valor em
 * dinheiro vem do servidor (catálogo e cotação); o navegador não calcula preço, desconto nem proporcional. A
 * query da volta do checkout só dispara o "Já paguei" (o servidor confirma com o provedor). Mensagens de erro
 * vêm do `status` e do `error.code`; nada de cobrança vai a `localStorage`, `sessionStorage`, URL ou `console`.
 */
export function SubscriptionPage({
  checkoutReturn,
  onReturnConsumed,
  onChanged,
  onSession,
  onOpenCompanies,
  pollMs = POLL_DEFAULT_MS,
}: SubscriptionPageProps) {
  const [billing, setBilling] = useState<Billing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<'resumo' | 'planos' | 'pagamentos'>('resumo');
  const generation = useRef(0);
  const quoteGeneration = useRef(0);
  const sessionRef = useRef(onSession);
  sessionRef.current = onSession;
  const consumedRef = useRef(onReturnConsumed);
  consumedRef.current = onReturnConsumed;
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;

  /** Falha comum: sessão (login), cobrança desligada ou mensagem escolhida pelo site. `null` se já tratada. */
  const messageOf = useCallback((error: unknown): string | null => {
    const failure = billingFailure(error);
    if (failure.kind === 'session') {
      sessionRef.current();
      return null;
    }
    if (failure.kind === 'disabled') {
      setDisabled(true);
      return null;
    }
    return failure.text;
  }, []);

  const load = useCallback(
    async (keepSelection: boolean): Promise<Billing | null> => {
      const stamp = ++generation.current;
      try {
        const next = await billingApi.overview();
        if (stamp !== generation.current) return null;
        setBilling(next);
        setLoadError(null);
        if (!keepSelection) setSelection(defaultSelection(next));
        return next;
      } catch (error) {
        if (stamp !== generation.current) return null;
        const text = messageOf(error);
        if (text !== null) setLoadError(text);
        return null;
      }
    },
    [messageOf],
  );

  useEffect(() => {
    void load(false);
    return () => {
      generation.current++;
    };
  }, [load, attempt]);

  // Cotação do servidor para a escolha atual (o navegador não calcula preço). Resposta tardia é descartada.
  const checkoutEnabled = billing?.checkoutEnabled === true;
  const hasSubscription = billing !== null && billing.subscription !== null;
  useEffect(() => {
    if (selection === null || !checkoutEnabled || !hasSubscription) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    const stamp = ++quoteGeneration.current;
    setQuote(null);
    setQuoteError(null);
    billingApi
      .quote(selection)
      .then((result) => {
        if (stamp === quoteGeneration.current) setQuote(result);
      })
      .catch((error: unknown) => {
        if (stamp !== quoteGeneration.current) return;
        const text = messageOf(error);
        if (text !== null) setQuoteError(text);
      });
    return () => {
      quoteGeneration.current++;
    };
    // A leitura inteira entra para a cotação refletir uma troca recém-feita (nova leitura, nova cotação).
  }, [selection, checkoutEnabled, hasSubscription, billing, messageOf]);

  // Volta do checkout: dispara o "Já paguei" uma única vez (a query nunca concede nada) e reconsulta.
  const returned = useRef(false);
  useEffect(() => {
    if (checkoutReturn === null || returned.current) return;
    returned.current = true;
    setWaiting({
      orderId: checkoutReturn.orderId,
      transactionNsu: checkoutReturn.transactionNsu,
      slug: checkoutReturn.slug,
    });
    consumedRef.current();
  }, [checkoutReturn]);

  // Espera pelo pagamento: consulta já e repete a cada `pollMs`, por no máximo ~1 minuto.
  useEffect(() => {
    if (waiting === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const run = async (): Promise<void> => {
      attempts += 1;
      try {
        const result = await billingApi.check(waiting.orderId, {
          transactionNsu: waiting.transactionNsu,
          slug: waiting.slug,
        });
        if (cancelled) return;
        if (result.outcome === 'paid') {
          setWaiting(null);
          setNotice({ tone: 'success', text: 'Pagamento confirmado. Seu plano já está ativo.' });
          void load(false);
          changedRef.current();
          return;
        }
        if (result.outcome === 'failed') {
          setWaiting(null);
          setNotice({
            tone: 'error',
            text: 'O pagamento não pôde ser concluído. Nada foi cobrado de você pelo Soprei; tente de novo.',
          });
          void load(true);
          return;
        }
      } catch (error) {
        if (cancelled) return;
        const text = messageOf(error);
        if (text === null) return;
      }
      if (attempts >= POLL_MAX_ATTEMPTS) {
        setWaiting(null);
        setNotice({
          tone: 'info',
          text: 'Ainda não recebemos a confirmação do pagamento. Se você já pagou, aguarde alguns minutos e use "Já paguei" no histórico abaixo.',
        });
        void load(true);
        return;
      }
      timer = setTimeout(() => void run(), pollMs);
    };
    void run();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [waiting, pollMs, load, messageOf]);

  const now = new Date();
  const view = useMemo(() => (quote === null ? null : quoteView(quote, new Date())), [quote]);

  const act = async (kind: Exclude<Busy, null>, run: () => Promise<void>): Promise<void> => {
    if (busy !== null) return;
    setBusy(kind);
    setNotice(null);
    try {
      await run();
      changedRef.current();
    } catch (error) {
      const text = messageOf(error);
      if (text !== null) setNotice({ tone: 'error', text });
    } finally {
      setBusy(null);
    }
  };

  /** Abre o link do checkout na mesma aba (só https, sem credenciais embutidas). */
  const openCheckout = (url: string): void => {
    const safe = safeCheckoutUrl(url, billing?.checkoutHost);
    if (safe === null) {
      setNotice({
        tone: 'error',
        text: 'O link de pagamento recebido não é válido. Tente novamente.',
      });
      return;
    }
    setNotice({ tone: 'info', text: 'Abrindo a página de pagamento…' });
    window.location.assign(safe);
  };

  const submit = (): void => {
    if (selection === null || view === null) return;
    if (view.action === 'schedule') {
      void act('schedule', async () => {
        await billingApi.schedule(selection);
        await load(true);
        setNotice({
          tone: 'success',
          text: 'Troca agendada para a próxima renovação. Você pode desfazer antes disso.',
        });
      });
      return;
    }
    void act('pay', async () => {
      const created =
        view.action === 'upgrade'
          ? await billingApi.upgrade(selection)
          : await billingApi.createOrder(selection);
      openCheckout(created.checkoutUrl);
    });
  };

  if (disabled) {
    return <p className="m-0 py-2">A cobrança não está habilitada neste ambiente.</p>;
  }
  if (loadError !== null) {
    return (
      <RetryAlert text={loadError} disabled={false} onRetry={() => setAttempt((v) => v + 1)} />
    );
  }
  if (billing === null) {
    return (
      <div className="grid place-items-center gap-3 py-10 text-sm text-muted-foreground">
        <Loader variant="spinner" size={28} label="Carregando a assinatura" />
        <span aria-hidden="true">Carregando a assinatura…</span>
      </div>
    );
  }

  const { subscription, usage } = billing;
  if (subscription === null) {
    return (
      <div className="grid gap-4" data-testid="sem-assinatura">
        <ToneAlert
          tone="info"
          title="Esta conta não tem assinatura própria"
          text={
            billing.trial.available
              ? `A assinatura é da conta que cria a empresa. Ao criar sua primeira empresa você ganha ${String(billing.trial.days)} ${plural(billing.trial.days, 'dia', 'dias')} de teste gratuito. Se você entrou por convite em uma empresa de outra conta, quem cuida da assinatura é a pessoa titular dessa conta.`
              : 'A assinatura é da conta que criou a empresa. Quem cuida dela é a pessoa titular da conta.'
          }
        />
        <div>
          <Button variant="outline" onClick={onOpenCompanies}>
            Ver minhas empresas
          </Button>
        </div>
      </div>
    );
  }

  const banner = stateBanner(subscription, now);
  // Cota esgotada: respostas, ou o limite de uso da IA em texto genérico e sem números (spec 040, D3).
  const exhausted = exhaustedBanner(usage);
  const catalog = billing.catalog;
  const current = defaultSelection(billing);
  const choosing = selection ?? current;
  const price = (plan: CatalogPlan) => priceOf(plan, choosing.cycle);
  const chosenPlan = catalog.find((plan) => plan.code === choosing.planCode);
  const chosenPrice = chosenPlan === undefined ? undefined : price(chosenPlan);
  const includedReplies = usage?.replies.limit ?? chosenPlan?.monthlyReplies ?? 0;
  const pending = subscription.pendingChange;
  const isSame = selection !== null && samePlan(selection, current);

  return (
    <div className="grid min-w-0 gap-5" data-testid="assinatura">
      {notice !== null && <ToneAlert tone={notice.tone} text={notice.text} />}
      {waiting !== null && (
        <div role="status" className="flex items-center gap-3 text-sm" data-testid="aguardando">
          <Loader variant="spinner" size={20} label="Confirmando o pagamento" />
          <span>Confirmando o seu pagamento… Isso pode levar alguns instantes.</span>
        </div>
      )}
      <ToneAlert tone={banner.tone} title={banner.title} text={banner.text} />
      {exhausted !== null && (
        <ToneAlert tone={exhausted.tone} title={exhausted.title} text={exhausted.text} />
      )}

      <SectionTabs
        label="Seções da assinatura"
        active={tab}
        onChange={setTab}
        tabs={[
          {
            key: 'resumo',
            label: 'Resumo',
            content: (
              <>
                <Section id="sec-plano" title="Seu plano">
                  <dl className="m-0 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">Plano</dt>
                      <dd className="m-0 font-medium">{subscription.planName}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Ciclo</dt>
                      <dd className="m-0 font-medium">{CYCLE_LABELS[subscription.cycle]}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Módulos</dt>
                      <dd className="m-0 font-medium">
                        Agenda: {subscription.agenda ? 'contratada' : 'não contratada'}; Estoque:{' '}
                        {subscription.stock ? 'contratado' : 'não contratado'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">
                        {subscription.status === 'TRIAL' ? 'Fim do teste' : 'Vencimento'}
                      </dt>
                      <dd className="m-0 font-medium">
                        {formatDate(
                          subscription.status === 'TRIAL'
                            ? (subscription.trialEndsAt ?? subscription.currentPeriodEnd)
                            : subscription.currentPeriodEnd,
                        )}{' '}
                        <span className="font-normal text-muted-foreground">
                          ({String(daysLeft(subscription.currentPeriodEnd, now))}{' '}
                          {plural(daysLeft(subscription.currentPeriodEnd, now), 'dia', 'dias')})
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Empresas</dt>
                      <dd className="m-0 font-medium">
                        {String(subscription.companies)} de {String(subscription.maxCompanies)}
                      </dd>
                    </div>
                  </dl>
                  {pending !== null && (
                    <div
                      className="grid gap-2 rounded-xl bg-muted p-3 text-sm text-foreground"
                      data-testid="troca-agendada"
                    >
                      <p className="m-0">
                        <strong>Troca agendada:</strong> na próxima renovação o plano passa a ser{' '}
                        {describeSelection(catalog, pending)}. Nada é cobrado agora.
                      </p>
                      <div>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() =>
                            void act('undo', async () => {
                              await billingApi.undoPending();
                              await load(true);
                              setNotice({ tone: 'success', text: 'Troca agendada desfeita.' });
                            })
                          }
                        >
                          Desfazer troca agendada
                        </Button>
                      </div>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {canReactivate(subscription) && (
                      <Button
                        disabled={busy !== null}
                        onClick={() =>
                          void act('reactivate', async () => {
                            await billingApi.reactivate();
                            await load(true);
                            setNotice({
                              tone: 'success',
                              text: 'Assinatura reativada: ela volta a renovar.',
                            });
                          })
                        }
                      >
                        Reativar assinatura
                      </Button>
                    )}
                    {canCancel(subscription) && billing.checkoutEnabled && (
                      <Button
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => setConfirmCancel(true)}
                      >
                        Cancelar assinatura
                      </Button>
                    )}
                  </div>
                </Section>

                {usage !== null && (
                  <Section id="sec-uso" title="Uso deste mês">
                    <p className="m-0 text-sm text-muted-foreground">
                      Respostas enviadas pelo WhatsApp neste mês (janela de uso de{' '}
                      {formatDate(usage.windowStart)} até {formatDate(usage.windowEnd)}).
                    </p>
                    {/* Só respostas: o limite de uso da IA é proteção de custo e fica fora da tela (spec 040). */}
                    <UsageBar
                      id="respostas"
                      label="Respostas enviadas"
                      used={usage.replies.used}
                      limit={usage.replies.limit}
                      unit="respostas"
                    />
                    <div
                      className="grid gap-1 rounded-xl bg-muted p-3 text-sm text-foreground"
                      data-testid="estimativa-meta"
                    >
                      <p className="m-0">
                        <strong>Estimativa de custo na Meta este mês:</strong>{' '}
                        {formatMoney(metaEstimateCents(usage.metaEstimate.milliCents))} (estimativa)
                      </p>
                      <p className="m-0 text-muted-foreground">{META_ESTIMATE_NOTE}</p>
                    </div>
                  </Section>
                )}

                <p
                  className="m-0 rounded-xl border border-border p-3 text-sm"
                  data-testid="aviso-whatsapp"
                >
                  {whatsappNotice(subscription.whatsappNotice, includedReplies)}
                </p>
              </>
            ),
          },
          {
            key: 'planos',
            label: 'Planos',
            content: (
              <>
                {billing.checkoutEnabled ? (
                  <Section id="sec-escolher" title="Escolher plano">
                    <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
                      <legend className="mb-1 p-0 text-sm font-medium">Ciclo de cobrança</legend>
                      <div className="flex flex-wrap gap-2">
                        {CYCLES.map((cycle) => (
                          <label
                            key={cycle}
                            className="flex min-h-11 items-center gap-2 rounded-xl border border-border px-3 text-sm"
                          >
                            <input
                              type="radio"
                              name="ciclo"
                              className="size-5"
                              checked={choosing.cycle === cycle}
                              onChange={() => setSelection({ ...choosing, cycle })}
                            />
                            <span>
                              {CYCLE_LABELS[cycle]}
                              {CYCLE_NOTES[cycle]}
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>

                    <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
                      <legend className="mb-1 p-0 text-sm font-medium">Plano</legend>
                      <div className="grid gap-2 sm:grid-cols-3">
                        {catalog.map((plan) => {
                          const planPrice = price(plan);
                          const periodo = choosing.cycle === 'MONTHLY' ? 'por mês' : 'por ano';
                          const perReply = perReplyText(planPrice?.perReplyMilliCents);
                          return (
                            <label
                              key={plan.code}
                              className="flex min-w-0 items-start gap-2 rounded-xl border border-border p-3 text-sm"
                            >
                              <input
                                type="radio"
                                name="plano"
                                className="mt-0.5 size-5 shrink-0"
                                checked={choosing.planCode === plan.code}
                                onChange={() => setSelection({ ...choosing, planCode: plan.code })}
                              />
                              <span className="grid min-w-0 gap-0.5">
                                <strong>{plan.name}</strong>
                                <span className="text-muted-foreground">
                                  Até {String(plan.maxCompanies)}{' '}
                                  {plural(plan.maxCompanies, 'empresa', 'empresas')}
                                </span>
                                <span className="text-muted-foreground">
                                  {formatCount(plan.monthlyReplies)} respostas por mês
                                </span>
                                <span>
                                  {planPrice === undefined
                                    ? 'Indisponível neste ciclo'
                                    : `${formatMoney(planPrice.baseCents)} ${periodo}`}
                                </span>
                                {perReply !== null && (
                                  <span
                                    className="text-muted-foreground"
                                    data-testid={`por-resposta-${plan.code}`}
                                  >
                                    {perReply}
                                  </span>
                                )}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>

                    <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
                      <legend className="mb-1 p-0 text-sm font-medium">Módulos opcionais</legend>
                      <label className="flex min-h-11 items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="mt-0.5 size-5 shrink-0"
                          checked={choosing.agenda}
                          onChange={(event) =>
                            setSelection({ ...choosing, agenda: event.target.checked })
                          }
                        />
                        <span>
                          Agenda
                          {chosenPrice !== undefined &&
                            ` (+ ${formatMoney(chosenPrice.agendaCents)})`}
                        </span>
                      </label>
                      <label className="flex min-h-11 items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="mt-0.5 size-5 shrink-0"
                          checked={choosing.stock}
                          onChange={(event) =>
                            setSelection({ ...choosing, stock: event.target.checked })
                          }
                        />
                        <span>
                          Estoque
                          {chosenPrice !== undefined &&
                            ` (+ ${formatMoney(chosenPrice.stockCents)})`}
                        </span>
                      </label>
                    </fieldset>

                    <div className="grid gap-2" aria-live="polite" data-testid="cotacao">
                      {quote === null && quoteError === null && (
                        <p className="m-0 text-sm text-muted-foreground">Calculando o valor…</p>
                      )}
                      {quoteError !== null && (
                        <p className="m-0 text-sm font-medium text-destructive" role="alert">
                          {quoteError}
                        </p>
                      )}
                      {view !== null && (
                        <p className="m-0 text-sm" data-testid="cotacao-texto">
                          {view.text}
                        </p>
                      )}
                      {quote !== null && quote.amountCents > 0 && (
                        <p className="m-0 text-2xl font-semibold" data-testid="total">
                          {formatMoney(quote.amountCents)}
                        </p>
                      )}
                    </div>
                    <div>
                      <Button
                        disabled={
                          busy !== null || view === null || quoteError !== null || waiting !== null
                        }
                        onClick={submit}
                      >
                        {busy === 'pay' || busy === 'schedule'
                          ? 'Aguarde…'
                          : (view?.button ?? 'Continuar')}
                      </Button>
                      {isSame && view?.action === 'pay' && subscription.status === 'TRIAL' && (
                        <p className="m-0 pt-2 text-sm text-muted-foreground">
                          Esta é a escolha do seu teste. Pague para continuar depois do fim dele.
                        </p>
                      )}
                    </div>
                  </Section>
                ) : (
                  <p className="m-0 text-sm text-muted-foreground">
                    O pagamento ainda não está habilitado neste ambiente; você pode acompanhar o
                    plano e o uso.
                  </p>
                )}
                {/* Spec 040 (D10): o quarto cartão, fora do grupo de rádios e com ou sem checkout. */}
                <EnterpriseCard />
              </>
            ),
          },
          {
            key: 'pagamentos',
            label: 'Pagamentos',
            content: (
              <Section id="sec-historico" title="Pedidos e pagamentos">
                {billing.orders.length === 0 ? (
                  <p className="m-0 text-sm text-muted-foreground">Nenhum pedido ainda.</p>
                ) : (
                  <ul className="m-0 grid list-none gap-2 p-0">
                    {billing.orders.map((order) => (
                      <li
                        key={order.id}
                        data-testid="pedido"
                        className="grid min-w-0 gap-1 rounded-xl border border-border p-3 text-sm"
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                          <strong>{ORDER_KIND_LABELS[order.kind]}</strong>
                          <span>{formatMoney(order.amountCents)}</span>
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
                          <span>
                            {formatDate(order.createdAt)} · {ORDER_STATUS_LABELS[order.status]}
                            {order.paidAt === null ? '' : ` em ${formatDate(order.paidAt)}`}
                          </span>
                          {canCheckOrder(order, now) && billing.checkoutEnabled && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy !== null || waiting !== null}
                              onClick={() =>
                                void act('check', async () => {
                                  const result = await billingApi.check(order.id);
                                  await load(true);
                                  setNotice(
                                    result.outcome === 'paid'
                                      ? {
                                          tone: 'success',
                                          text: 'Pagamento confirmado. Seu plano já está ativo.',
                                        }
                                      : result.outcome === 'failed'
                                        ? {
                                            tone: 'error',
                                            text: 'O pagamento não pôde ser concluído. Tente de novo.',
                                          }
                                        : {
                                            tone: 'info',
                                            text: 'Ainda não recebemos a confirmação deste pagamento. Tente de novo em instantes.',
                                          },
                                  );
                                })
                              }
                            >
                              Já paguei
                            </Button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            ),
          },
        ]}
      />

      <ConfirmDialog
        request={
          confirmCancel
            ? {
                title: 'Cancelar a assinatura?',
                text: `A assinatura não será renovada e continua valendo até ${formatDate(subscription.currentPeriodEnd)}. Depois dessa data o atendente para de responder e o painel fica só para leitura. Nada é apagado e você pode reativar antes do fim.`,
                confirmLabel: 'Cancelar assinatura',
              }
            : null
        }
        busy={busy === 'cancel'}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() =>
          void act('cancel', async () => {
            await billingApi.cancel();
            setConfirmCancel(false);
            await load(true);
            setNotice({
              tone: 'success',
              text: `Assinatura cancelada: ela não será renovada e vale até ${formatDate(subscription.currentPeriodEnd)}.`,
            });
          }).finally(() => setConfirmCancel(false))
        }
      />
    </div>
  );
}
