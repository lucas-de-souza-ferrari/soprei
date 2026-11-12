import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { Alert, AlertContent, AlertDescription, AlertIcon } from '../components/motion/alert';
import { Button } from '../components/motion/button';
import { Loader } from '../components/motion/loader';
import { type AgendaService, agendaApi, agendaMessageOf } from './agenda-api';
import { ServiceForm } from './AgendaDialogs';
import type { StepBridge } from './onboarding-steps';
import type { PageProps } from './PersonaPage';
import { RetryAlert } from './RetryAlert';

type Notice = { tone: 'error' | 'success'; text: string } | null;

const SAVE_FAILED = 'Não foi possível salvar agora. Tente de novo.';
const OWN_MESSAGE_STATUSES = [403, 429, 502, 503];

export interface OnboardingServicesProps extends PageProps, Pick<StepBridge, 'onProgress'> {
  /** Abre a tela completa de configuração da agenda. */
  readonly onConfigure: () => void;
}

/**
 * Passo "Serviços" do assistente (spec 030, E2): o **menor** formulário da agenda (criar serviço, o mesmo
 * `ServiceForm` de Configurar agenda) e "Usar exemplo" (`POST .../schedule/sample`). Não reescreve a tela
 * de configuração: janelas, recursos e opções da IA continuam lá ("Configurar agenda"). Nomes de serviço só
 * vivem em memória; resposta de empresa anterior é descartada.
 */
export function OnboardingServices({
  companyId,
  settle,
  onProgress,
  onConfigure,
}: OnboardingServicesProps) {
  const [services, setServices] = useState<readonly AgendaService[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Muda a chave do formulário depois de salvar (limpa os campos).
  const [formKey, setFormKey] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    setLoadError(null);
    const stamp = ++generation.current;
    agendaApi
      .services(companyId)
      .then((items) => {
        if (stamp === generation.current) setServices(items);
      })
      .catch((error: unknown) => {
        if (stamp !== generation.current) return;
        const text = settle(error);
        if (text !== null) setLoadError(text);
      });
    return () => {
      generation.current++;
    };
  }, [companyId, settle, attempt]);

  const run = useCallback(
    async (work: () => Promise<void>, inForm: boolean): Promise<void> => {
      const stamp = ++generation.current;
      setBusy(true);
      setNotice(null);
      setProblem(null);
      try {
        await work();
        if (stamp !== generation.current) return;
        onProgress?.();
        setAttempt((value) => value + 1);
      } catch (error) {
        if (stamp !== generation.current) return;
        const own = agendaMessageOf(error);
        if (own !== null) {
          if (inForm && error instanceof ApiError && error.status === 400) setProblem(own);
          else setNotice({ tone: 'error', text: own });
          if (error instanceof ApiError && error.status === 409) setAttempt((value) => value + 1);
          return;
        }
        const text = settle(error);
        if (text !== null) {
          const known = error instanceof ApiError && OWN_MESSAGE_STATUSES.includes(error.status);
          setNotice({ tone: 'error', text: known ? text : SAVE_FAILED });
        }
      } finally {
        if (stamp === generation.current) setBusy(false);
      }
    },
    [onProgress, settle],
  );

  if (loadError !== null) {
    return (
      <RetryAlert
        text={loadError}
        disabled={false}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    );
  }
  if (services === null) {
    return (
      <div className="grid place-items-center gap-3 py-6 text-sm text-muted-foreground">
        <Loader variant="spinner" size={28} label="Carregando os serviços" />
        <span aria-hidden="true">Carregando os serviços…</span>
      </div>
    );
  }

  // O exemplo só carrega sem serviço seu (o servidor recusa o resto com 409 `SAMPLE_REQUIRES_EMPTY`).
  const canLoadSample = services.every((service) => service.isSample && !service.active);
  const active = services.filter((service) => service.active);

  return (
    <div className="grid gap-4">
      <p className="m-0 rounded-2xl border border-border bg-muted p-3 text-sm text-foreground">
        Sem horários semanais, o atendente não tem o que oferecer. Depois de criar o serviço, defina
        os horários em Configurar agenda.
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
      {canLoadSample && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await agendaApi.loadSample(companyId);
                setNotice({
                  tone: 'success',
                  text: 'Exemplo carregado: serviço “Corte de cabelo” e horários de segunda a sexta, das 9h às 18h.',
                });
              }, false)
            }
          >
            Usar exemplo
          </Button>
          <span className="text-sm text-muted-foreground">
            Cria um serviço de 30 minutos e a semana útil das 9h às 18h.
          </span>
        </div>
      )}
      {active.length > 0 && (
        <ul className="m-0 grid list-none gap-2 p-0" aria-label="Serviços ativos">
          {active.map((service) => (
            <li
              key={service.id}
              className="rounded-xl border border-border px-3 py-2 text-sm [overflow-wrap:anywhere]"
            >
              {service.name}
              {service.isSample ? ' (exemplo)' : ''}
            </li>
          ))}
        </ul>
      )}
      <ServiceForm
        key={formKey}
        service={null}
        busy={busy}
        problem={problem}
        onSubmit={(values) =>
          void run(async () => {
            await agendaApi.createService(companyId, values);
            setFormKey((value) => value + 1);
            setNotice({ tone: 'success', text: 'Serviço salvo.' });
          }, true)
        }
      />
      <div>
        <Button variant="outline" onClick={onConfigure}>
          Configurar agenda
        </Button>
      </div>
    </div>
  );
}
