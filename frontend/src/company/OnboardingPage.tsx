import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Check, Circle, MinusCircle } from 'lucide-react';
import { Button } from '../components/motion/button';
import { Loader } from '../components/motion/loader';
import type { AreaPage } from './company-nav';
import { ConfirmDialog } from './ConfirmDialog';
import { EstoquePage } from './EstoquePage';
import { KnowledgePage } from './KnowledgePage';
import { OnboardingServices } from './OnboardingServices';
import { onboardingApi } from './onboarding-api';
import {
  navigableSteps,
  type OnboardingState,
  resolveStep,
  type StepDraft,
  visibleSteps,
  type WizardStep,
  type WizardStepId,
} from './onboarding-steps';
import { PersonaPage, type PageProps } from './PersonaPage';
import { RetryAlert } from './RetryAlert';
import { TestPage } from './TestPage';

export interface OnboardingPageProps extends PageProps {
  readonly permissions: readonly string[];
  /** Passo pedido pelo endereço (`null`: o primeiro pendente). */
  readonly step: WizardStepId | null;
  /** Troca o passo no endereço (`replace` quando só se normaliza o endereço, sem nova entrada no histórico). */
  readonly onStep: (step: WizardStepId, replace: boolean) => void;
  readonly onNavigate: (page: AreaPage) => void;
}

type StepStatus = 'done' | 'skipped' | 'pending';

const STATUS_TEXT: Readonly<Record<StepStatus, string>> = {
  done: 'Feito',
  skipped: 'Pulado',
  pending: 'Pendente',
};

function StatusIcon({ status }: { status: StepStatus }) {
  const Icon = status === 'done' ? Check : status === 'skipped' ? MinusCircle : Circle;
  return (
    <Icon
      aria-hidden="true"
      className={`size-4 shrink-0 ${status === 'done' ? 'text-(--color-success)' : 'text-muted-foreground'}`}
    />
  );
}

/** Texto curto de cada passo: o que é e por que importa. */
const STEP_INTRO: Readonly<Record<WizardStepId, string>> = {
  persona:
    'A persona diz ao atendente como falar: o tom, o nome do negócio e o que ele pode ou não dizer.',
  documentos:
    'Os documentos são a fonte das respostas: política de trocas, horários, perguntas frequentes.',
  servicos: 'Os serviços da agenda são o que o atendente pode oferecer aos contatos (opcional).',
  estoque: 'O estoque deixa o atendente informar preço e disponibilidade (opcional).',
  testar: 'Mande uma mensagem como se fosse um contato e veja como o atendente responde.',
};

/**
 * Assistente de primeiros passos (spec 030), dentro do shell do painel. O progresso vem do servidor
 * (`GET .../onboarding`, só booleanos); "Pular", "Testar" e o rascunho vivem só nesta tela. Cada passo
 * reaproveita a tela de sempre com pontes opcionais (`onProgress`, `onDraft`). Troca de empresa remonta
 * a tela (`key` em quem a usa) e resposta tardia é descartada.
 */
export function OnboardingPage({
  companyId,
  permissions,
  settle,
  step,
  onStep,
  onNavigate,
}: OnboardingPageProps) {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [skipped, setSkipped] = useState<ReadonlySet<WizardStepId>>(new Set());
  const [hasDraft, setHasDraft] = useState(false);
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [announce, setAnnounce] = useState('');
  const generation = useRef(0);
  const draft = useRef<StepDraft | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const reopened = useRef(false);

  const refresh = useCallback(
    (silent: boolean): void => {
      const stamp = ++generation.current;
      if (!silent) setLoadError(null);
      onboardingApi
        .get(companyId)
        .then((next) => {
          if (stamp === generation.current) setState(next);
        })
        .catch((error: unknown) => {
          if (stamp !== generation.current) return;
          const text = settle(error);
          if (text !== null && !silent) setLoadError(text);
        });
    },
    [companyId, settle],
  );

  useEffect(() => {
    refresh(false);
    return () => {
      generation.current++;
    };
  }, [refresh, attempt]);

  const onProgress = useCallback(() => refresh(true), [refresh]);
  const onDraft = useCallback((next: StepDraft | null) => {
    draft.current = next;
    setHasDraft(next !== null);
  }, []);

  // Reabrir: entrar no assistente pelo menu desfaz o "dispensado" (melhor esforço, não bloqueia).
  useEffect(() => {
    if (state === null || !state.dismissed || reopened.current) return;
    reopened.current = true;
    onboardingApi
      .setDismissed(companyId, false)
      .then((next) => setState(next))
      .catch((error: unknown) => {
        settle(error);
      });
  }, [state, companyId, settle]);

  const steps = state === null ? [] : visibleSteps(state, permissions);
  const current = state === null ? null : resolveStep(steps, step);
  const screens = navigableSteps(steps);
  const currentInfo = steps.find((item) => item.id === current);
  const total = steps.length;

  // Endereço sempre mostra o passo certo (normaliza o endereço base e valores inválidos).
  useEffect(() => {
    if (state !== null && current !== null && current !== step) onStep(current, true);
  }, [state, current, step, onStep]);

  // A cada troca de passo: foco no título e anúncio para leitor de tela.
  useEffect(() => {
    if (current === null || currentInfo === undefined) return;
    setAnnounce(`Passo ${String(currentInfo.number)} de ${String(total)}: ${currentInfo.label}`);
    heading.current?.focus();
    // O foco só se move quando o passo muda, não a cada releitura do progresso.
  }, [current]);

  const statusOf = (item: WizardStep): StepStatus =>
    item.done ? 'done' : item.id !== 'empresa' && skipped.has(item.id) ? 'skipped' : 'pending';

  /** Sai do passo atual; com rascunho não salvo, pede confirmação antes de descartar. */
  const leave = (action: () => void): void => {
    if (draft.current !== null) setLeaving(() => action);
    else action();
  };
  const goTo = (target: WizardStepId): void => {
    leave(() => {
      onStep(target, false);
      setListOpen(false);
    });
  };

  if (loadError !== null) {
    return (
      <RetryAlert
        text={loadError}
        disabled={false}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    );
  }

  if (state === null) {
    return (
      <div className="grid place-items-center gap-3 py-10 text-sm text-muted-foreground">
        <Loader variant="spinner" size={28} label="Carregando os primeiros passos" />
        <span aria-hidden="true">Carregando os primeiros passos…</span>
      </div>
    );
  }

  if (current === null || currentInfo === undefined) {
    return <p className="m-0 py-2">Não há passos de configuração disponíveis para o seu acesso.</p>;
  }

  const index = screens.findIndex((item) => item.id === current);
  const previous = index > 0 ? screens[index - 1] : undefined;
  const next = index >= 0 ? screens[index + 1] : undefined;
  const isLast = next === undefined;

  const advance = (): void => {
    if (next !== undefined && next.id !== 'empresa') goTo(next.id);
  };
  const skip = (): void => {
    leave(() => {
      setSkipped((value) => new Set(value).add(current));
      if (next !== undefined && next.id !== 'empresa') {
        onStep(next.id, false);
        setListOpen(false);
      }
    });
  };
  const saveAndAdvance = async (): Promise<void> => {
    const pending = draft.current;
    if (pending === null) return advance();
    setSaving(true);
    try {
      if (await pending.save()) {
        draft.current = null;
        setHasDraft(false);
        if (next !== undefined && next.id !== 'empresa') {
          onStep(next.id, false);
          setListOpen(false);
        }
      }
    } finally {
      setSaving(false);
    }
  };

  const body = ((): ReactNode => {
    switch (current) {
      case 'persona':
        return (
          <PersonaPage
            key={companyId}
            companyId={companyId}
            settle={settle}
            onProgress={onProgress}
            onDraft={onDraft}
            withTemplate
          />
        );
      case 'documentos':
        return (
          <DocumentsStep
            key={companyId}
            companyId={companyId}
            settle={settle}
            canSample={permissions.includes('inventory:manage') && state.steps.inventory !== true}
            onProgress={onProgress}
            onDraft={onDraft}
          />
        );
      case 'servicos':
        return (
          <OnboardingServices
            key={companyId}
            companyId={companyId}
            settle={settle}
            onProgress={onProgress}
            onConfigure={() => onNavigate('agendaConfig')}
          />
        );
      case 'estoque':
        return (
          <StockStep
            key={companyId}
            companyId={companyId}
            settle={settle}
            canSample={permissions.includes('knowledge:manage') && state.steps.knowledge !== true}
            onProgress={onProgress}
          />
        );
      default:
        return (
          <TestStep
            key={companyId}
            companyId={companyId}
            settle={settle}
            canOpenChannel={permissions.includes('channel:read')}
            onNavigate={onNavigate}
          />
        );
    }
  })();

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-5">
      <header className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="m-0 text-sm font-medium" data-testid="passo-atual">
            Passo {currentInfo.number} de {total}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="md:hidden"
            aria-expanded={listOpen}
            aria-controls="lista-de-passos"
            onClick={() => setListOpen((value) => !value)}
          >
            {listOpen ? 'Ocultar passos' : 'Ver passos'}
          </Button>
        </div>
        <div
          role="progressbar"
          aria-label="Progresso dos primeiros passos"
          aria-valuemin={1}
          aria-valuemax={total}
          aria-valuenow={currentInfo.number}
          aria-valuetext={`Passo ${String(currentInfo.number)} de ${String(total)}`}
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary motion-safe:transition-[width]"
            style={{ width: `${String(Math.round((currentInfo.number / total) * 100))}%` }}
          />
        </div>
        <nav
          id="lista-de-passos"
          aria-label="Passos"
          className={`${listOpen ? 'block' : 'hidden'} md:block`}
        >
          <ol className="m-0 grid list-none gap-1 p-0 md:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]">
            {steps.map((item) => {
              const status = statusOf(item);
              const isCurrent = item.id === current;
              const content = (
                <>
                  <StatusIcon status={status} />
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    <span className="block text-sm">
                      {item.number}. {item.label}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {STATUS_TEXT[status]}
                      {item.optional ? ' · opcional' : ''}
                    </span>
                  </span>
                </>
              );
              return (
                <li key={item.id}>
                  {item.id === 'empresa' ? (
                    <div className="flex items-start gap-2 rounded-xl border border-transparent p-2 text-foreground">
                      {content}
                    </div>
                  ) : (
                    <button
                      type="button"
                      aria-current={isCurrent ? 'step' : undefined}
                      onClick={() => {
                        if (item.id !== 'empresa' && !isCurrent) goTo(item.id);
                        else setListOpen(false);
                      }}
                      className={`flex min-h-11 w-full items-start gap-2 rounded-xl border p-2 text-left text-foreground ${
                        isCurrent ? 'border-border bg-muted font-semibold' : 'border-transparent'
                      }`}
                    >
                      {content}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      </header>

      <p className="sr-only" aria-live="polite">
        {announce}
      </p>

      <section className="grid gap-4 rounded-2xl border border-border bg-card p-4 text-card-foreground sm:p-6">
        <h2 ref={heading} tabIndex={-1} className="m-0 text-xl font-semibold outline-none">
          {currentInfo.label}
        </h2>
        <p className="m-0 text-sm text-muted-foreground">{STEP_INTRO[current]}</p>
        {current === 'documentos' &&
          permissions.includes('inventory:manage') &&
          state.steps.inventory !== true && (
            <p className="m-0 rounded-2xl border border-border bg-muted p-3 text-sm text-foreground">
              Se usar o exemplo, ele também cria produtos de mentira: o passo Estoque passa a feito.
            </p>
          )}
        {body}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="outline"
          disabled={previous === undefined || saving}
          onClick={() => previous !== undefined && previous.id !== 'empresa' && goTo(previous.id)}
        >
          Voltar
        </Button>
        <div className="flex flex-wrap gap-2">
          {!isLast && (
            <Button variant="outline" disabled={saving} onClick={skip}>
              Pular
            </Button>
          )}
          {isLast ? (
            <Button
              disabled={saving}
              onClick={() => {
                leave(() => onNavigate(firstAllowed(permissions)));
              }}
            >
              Ir para as conversas
            </Button>
          ) : (
            <Button disabled={saving} onClick={() => void saveAndAdvance()}>
              {saving ? 'Salvando…' : hasDraft ? 'Salvar e continuar' : 'Continuar'}
            </Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        request={
          leaving === null
            ? null
            : {
                title: 'Sair do passo?',
                text: 'Você tem texto não salvo. Sair e descartar?',
                confirmLabel: 'Sair e descartar',
              }
        }
        busy={false}
        onConfirm={() => {
          const action = leaving;
          setLeaving(null);
          draft.current = null;
          setHasDraft(false);
          action?.();
        }}
        onCancel={() => setLeaving(null)}
      />
    </div>
  );
}

function firstAllowed(permissions: readonly string[]): AreaPage {
  return permissions.includes('conversation:read') ? 'conversas' : 'primeirosPassos';
}

/**
 * Se o exemplo pode ser oferecido é decidido **uma vez**, ao entrar no passo: carregar o exemplo muda o
 * progresso (documentos e produtos passam a existir), mas a mensagem de sucesso e o "Remover exemplo" da
 * tela precisam continuar visíveis. A regra de verdade (empresa sem documento e sem produto) é do servidor.
 */
function DocumentsStep({ canSample, ...rest }: ComponentProps<typeof KnowledgePage>) {
  const [offer] = useState(canSample);
  return <KnowledgePage {...rest} canSample={offer} />;
}

function StockStep({ canSample, ...rest }: ComponentProps<typeof EstoquePage>) {
  const [offer] = useState(canSample);
  return <EstoquePage {...rest} canSample={offer} />;
}

/**
 * Passo "Testar o atendente": o `TestPage` de sempre (simulador, resposta e "Fontes usadas"). Nada daqui é
 * derivado nem gravado pelo assistente. Fecha com a sugestão de conectar o WhatsApp (só leva à tela Canal).
 */
function TestStep({
  companyId,
  settle,
  canOpenChannel,
  onNavigate,
}: PageProps & {
  readonly canOpenChannel: boolean;
  readonly onNavigate: (page: AreaPage) => void;
}) {
  return (
    <div className="grid gap-4">
      <p className="m-0 rounded-2xl border border-border bg-muted p-3 text-sm text-foreground">
        Se o ambiente usa o provedor de teste (mock), a resposta é de mentira: serve para ver o
        caminho funcionando, não a qualidade do atendimento.
      </p>
      <TestPage companyId={companyId} settle={settle} />
      {canOpenChannel && (
        <div className="grid gap-2 rounded-2xl border border-border p-3">
          <p className="m-0 text-sm">
            Quando estiver pronto, conecte o WhatsApp da empresa para atender contatos de verdade.
          </p>
          <div>
            <Button variant="outline" onClick={() => onNavigate('canal')}>
              Conectar o WhatsApp
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
