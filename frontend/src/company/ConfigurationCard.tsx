import { useEffect, useId, useRef, useState } from 'react';
import { Check, Circle } from 'lucide-react';
import { ApiError } from '../api';
import { Alert, AlertContent, AlertDescription, AlertIcon } from '../components/motion/alert';
import { Button } from '../components/motion/button';
import { ConfirmDialog } from './ConfirmDialog';
import { onboardingApi } from './onboarding-api';
import {
  checklistCounts,
  checklistItems,
  type OnboardingState,
  showChecklist,
  wizardPath,
  type WizardStepId,
} from './onboarding-steps';

export interface ConfigurationCardProps {
  readonly companyId: string;
  readonly permissions: readonly string[];
  /** Falha com mensagem de tela (texto) ou tratada por quem chama (login, empresa trocada: `null`). */
  readonly settle: (error: unknown) => string | null;
  /** Abre um passo do assistente. */
  readonly onOpenStep: (step: WizardStepId) => void;
}

const DISMISS_FAILED = 'Não foi possível dispensar agora. Tente de novo.';

/**
 * Cartão "Configuração" (spec 030, E3): lembra do que falta (persona, documentos, serviços, estoque) enquanto
 * a empresa não dispensou e algum item visível está pendente. Só aparece com `onboarding:manage` (sem a
 * permissão **não há chamada**). Erro ao ler o estado nunca bloqueia a tela: o cartão simplesmente não
 * aparece. Cada item tem texto e ícone de feito/pendente (nunca só cor).
 */
export function ConfigurationCard({
  companyId,
  permissions,
  settle,
  onOpenStep,
}: ConfigurationCardProps) {
  const allowed = permissions.includes('onboarding:manage');
  const [state, setState] = useState<OnboardingState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const generation = useRef(0);
  const titleId = useId();

  useEffect(() => {
    if (!allowed) return;
    const stamp = ++generation.current;
    onboardingApi
      .get(companyId)
      .then((next) => {
        if (stamp === generation.current) setState(next);
      })
      .catch((error: unknown) => {
        // 401 e 404 têm tratamento próprio (login, empresa trocada); o resto só esconde o cartão.
        if (stamp === generation.current) settle(error);
      });
    return () => {
      generation.current++;
    };
  }, [allowed, companyId, settle]);

  if (!allowed || state === null || !showChecklist(state, permissions)) return null;
  const items = checklistItems(state);
  const { done, total } = checklistCounts(items);

  const dismiss = async (): Promise<void> => {
    const stamp = ++generation.current;
    setBusy(true);
    setProblem(null);
    try {
      const next = await onboardingApi.setDismissed(companyId, true);
      if (stamp !== generation.current) return;
      setState(next);
      setConfirming(false);
    } catch (error) {
      if (stamp !== generation.current) return;
      const text = settle(error);
      if (text !== null) {
        const own = error instanceof ApiError && [403, 429, 502, 503].includes(error.status);
        setProblem(own ? text : DISMISS_FAILED);
      }
      setConfirming(false);
    } finally {
      if (stamp === generation.current) setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby={titleId}
      className="grid gap-3 rounded-2xl border border-border bg-card p-4 text-card-foreground"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={titleId} className="m-0 text-lg font-semibold">
          Configuração: {done} de {total} itens
        </h3>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
          Dispensar
        </Button>
      </div>
      <div aria-live="polite">
        {problem !== null && (
          <Alert variant="destructive">
            <AlertIcon />
            <AlertContent>
              <AlertDescription className="text-inherit">{problem}</AlertDescription>
            </AlertContent>
          </Alert>
        )}
      </div>
      <ul className="m-0 grid list-none gap-1 p-0">
        {items.map((item) => (
          <li key={item.step}>
            <a
              href={wizardPath(item.step)}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                onOpenStep(item.step);
              }}
              className="flex min-h-11 items-center gap-2 rounded-xl px-2 py-1 text-sm text-foreground hover:bg-muted focus-visible:outline-3 focus-visible:outline-ring"
            >
              {item.done ? (
                <Check aria-hidden="true" className="size-4 shrink-0 text-(--color-success)" />
              ) : (
                <Circle aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {item.label}
                <span className="text-muted-foreground">
                  {' — '}
                  {item.done ? 'feito' : 'pendente'}
                  {item.optional ? ' (opcional)' : ''}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
      <p className="m-0 text-xs text-muted-foreground">
        Dispensar esconde esta lista para toda a empresa. Para vê-la de novo, abra &quot;Primeiros
        passos&quot; no menu.
      </p>
      <ConfirmDialog
        request={
          confirming
            ? {
                title: 'Dispensar a lista de configuração?',
                text: 'A lista some para todos os administradores da empresa. Você pode reabri-la em Primeiros passos, no menu.',
                confirmLabel: 'Dispensar',
              }
            : null
        }
        busy={busy}
        onConfirm={() => void dismiss()}
        onCancel={() => setConfirming(false)}
      />
    </section>
  );
}
