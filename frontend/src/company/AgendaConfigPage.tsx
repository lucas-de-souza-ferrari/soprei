import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { Alert, AlertContent, AlertDescription, AlertIcon } from '../components/motion/alert';
import { Button } from '../components/motion/button';
import { Input } from '../components/motion/input';
import { Loader } from '../components/motion/loader';
import {
  AGENDA_STALE_MESSAGE,
  type AgendaResource,
  type AgendaService,
  type AgendaSettings,
  type AgendaWindow,
  agendaApi,
  agendaMessageOf,
} from './agenda-api';
import {
  NAME_MAX_LENGTH,
  serviceFormProblem,
  SLOT_STEPS,
  WEEKDAY_LABELS,
  windowsProblem,
} from './agenda-rules';
import { Field, FIELD_CLASS, Problem } from './AgendaDialogs';
import { Modal } from './Modal';
import type { PageProps } from './PersonaPage';

type Notice = { tone: 'error' | 'success'; text: string } | null;
type Dialog =
  | { kind: 'service'; service: AgendaService | null }
  | { kind: 'resource'; resource: AgendaResource | null }
  | { kind: 'rules'; resource: AgendaResource }
  | null;

const SAVE_FAILED = 'Não foi possível salvar agora. Tente de novo.';
const OWN_MESSAGE_STATUSES = [403, 429, 502, 503];

function ServiceForm({
  service,
  busy,
  problem,
  onSubmit,
}: {
  service: AgendaService | null;
  busy: boolean;
  problem: string | null;
  onSubmit: (values: { name: string; durationMinutes: number; bufferMinutes: number }) => void;
}) {
  const [name, setName] = useState(service?.name ?? '');
  const [duration, setDuration] = useState(String(service?.durationMinutes ?? 30));
  const [buffer, setBuffer] = useState(String(service?.bufferMinutes ?? 0));
  const [local, setLocal] = useState<string | null>(null);
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const found = serviceFormProblem({ name, duration, buffer });
        if (found !== null) {
          setLocal(found);
          return;
        }
        onSubmit({
          name: name.trim(),
          durationMinutes: Number(duration),
          bufferMinutes: buffer.trim() === '' ? 0 : Number(buffer),
        });
      }}
    >
      <Problem text={local ?? problem} />
      <Input
        label="Nome do serviço"
        value={name}
        maxLength={NAME_MAX_LENGTH}
        onChange={(value) => {
          setName(value);
          setLocal(null);
        }}
      />
      <p className="m-0 text-sm text-muted-foreground">
        Evite nomes que revelem diagnóstico ou tratamento: o nome pode ser lido pela IA e aparece na
        agenda.
      </p>
      <Input
        label="Duração (minutos, múltiplos de 5)"
        inputMode="numeric"
        value={duration}
        onChange={(value) => {
          setDuration(value);
          setLocal(null);
        }}
      />
      <Input
        label="Intervalo depois do serviço (minutos)"
        inputMode="numeric"
        value={buffer}
        onChange={(value) => {
          setBuffer(value);
          setLocal(null);
        }}
      />
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Aguarde…' : 'Salvar'}
        </Button>
      </div>
    </form>
  );
}

function ResourceForm({
  resource,
  busy,
  problem,
  onSubmit,
}: {
  resource: AgendaResource | null;
  busy: boolean;
  problem: string | null;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(resource?.name ?? '');
  const [local, setLocal] = useState<string | null>(null);
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const text = name.trim();
        if (text === '' || text.length > NAME_MAX_LENGTH) {
          setLocal('Informe o nome (até 80 caracteres).');
          return;
        }
        onSubmit(text);
      }}
    >
      <Problem text={local ?? problem} />
      <Input
        label="Nome do profissional ou recurso"
        value={name}
        maxLength={NAME_MAX_LENGTH}
        onChange={(value) => {
          setName(value);
          setLocal(null);
        }}
      />
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Aguarde…' : 'Salvar'}
        </Button>
      </div>
    </form>
  );
}

function RulesForm({
  resource,
  busy,
  problem,
  onSubmit,
}: {
  resource: AgendaResource;
  busy: boolean;
  problem: string | null;
  onSubmit: (windows: AgendaWindow[]) => void;
}) {
  const [windows, setWindows] = useState<AgendaWindow[]>(() => [...resource.windows]);
  const [local, setLocal] = useState<string | null>(null);
  const update = (index: number, patch: Partial<AgendaWindow>): void => {
    setLocal(null);
    setWindows((current) =>
      current.map((window, position) => (position === index ? { ...window, ...patch } : window)),
    );
  };
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const found = windowsProblem(windows);
        if (found !== null) {
          setLocal(found);
          return;
        }
        onSubmit(windows);
      }}
    >
      <Problem text={local ?? problem} />
      <p className="m-0 text-sm text-muted-foreground">
        Os horários valem no relógio da empresa, toda semana. Para um intervalo de almoço, use dois
        horários no mesmo dia. Mudar os horários não cancela nem move agendamentos já feitos.
      </p>
      {WEEKDAY_LABELS.map((label, dayIndex) => {
        const weekday = dayIndex + 1;
        const dayWindows = windows
          .map((window, index) => ({ window, index }))
          .filter((entry) => entry.window.weekday === weekday);
        return (
          <fieldset key={weekday} className="grid gap-2 rounded-xl border border-border p-3">
            <legend className="px-1 text-sm font-medium">{label}</legend>
            {dayWindows.length === 0 && (
              <p className="m-0 text-sm text-muted-foreground">Sem atendimento.</p>
            )}
            {dayWindows.map(({ window, index }) => (
              <div key={index} className="flex flex-wrap items-end gap-2">
                <div className="w-32">
                  <Input
                    label="Das"
                    type="time"
                    value={window.start}
                    onChange={(value) => update(index, { start: value })}
                  />
                </div>
                <div className="w-32">
                  <Input
                    label="Às"
                    type="time"
                    value={window.end}
                    onChange={(value) => update(index, { end: value })}
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Remover horário de ${label}`}
                  onClick={() => {
                    setLocal(null);
                    setWindows((current) => current.filter((_, position) => position !== index));
                  }}
                >
                  Remover
                </Button>
              </div>
            ))}
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Adicionar horário em ${label}`}
                onClick={() => {
                  setLocal(null);
                  setWindows((current) => [...current, { weekday, start: '09:00', end: '18:00' }]);
                }}
              >
                Adicionar horário
              </Button>
            </div>
          </fieldset>
        );
      })}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Aguarde…' : 'Salvar horários'}
        </Button>
      </div>
    </form>
  );
}

export interface AgendaConfigPageProps extends PageProps {
  readonly onBack: () => void;
}

/**
 * Configuração da agenda (spec 027, só com `schedule:configure`): fuso, serviços, profissionais ou
 * recursos e horários da semana. Mudar o fuso não move agendamentos já gravados (são instantes); só
 * muda a hora local mostrada.
 */
export function AgendaConfigPage({ companyId, settle, onBack }: AgendaConfigPageProps) {
  const [settings, setSettings] = useState<AgendaSettings | null>(null);
  const [resources, setResources] = useState<readonly AgendaResource[]>([]);
  const [services, setServices] = useState<readonly AgendaService[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dialogProblem, setDialogProblem] = useState<string | null>(null);
  const [timezone, setTimezone] = useState('');
  const [step, setStep] = useState('30');
  const [minNotice, setMinNotice] = useState('120');
  const [maxAdvance, setMaxAdvance] = useState('60');
  // Spec 028: a IA pode solicitar, cancelar e remarcar horários; confirmar automaticamente.
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiAuto, setAiAuto] = useState(false);
  const [aiProblem, setAiProblem] = useState<string | null>(null);
  const [generalProblem, setGeneralProblem] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const stamp = ++generation.current;
    setLoadError(null);
    Promise.all([
      agendaApi.settings(companyId),
      agendaApi.resources(companyId),
      agendaApi.services(companyId),
    ])
      .then(([loadedSettings, resourceList, serviceList]) => {
        if (stamp !== generation.current) return;
        setSettings(loadedSettings);
        setTimezone(loadedSettings.timezone);
        setStep(String(loadedSettings.slotStepMinutes));
        setMinNotice(String(loadedSettings.minNoticeMinutes));
        setMaxAdvance(String(loadedSettings.maxAdvanceDays));
        setAiEnabled(loadedSettings.aiBookingEnabled);
        setAiAuto(loadedSettings.aiAutoConfirm);
        setResources(resourceList);
        setServices(serviceList);
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

  const failure = useCallback(
    (error: unknown, inDialog: boolean): void => {
      const own = agendaMessageOf(error);
      const text = own ?? settle(error);
      if (text === null) return;
      const known =
        own !== null || (error instanceof ApiError && OWN_MESSAGE_STATUSES.includes(error.status));
      const shown = known ? text : SAVE_FAILED;
      if (inDialog) setDialogProblem(shown);
      else setNotice({ tone: 'error', text: shown });
    },
    [settle],
  );

  const run = async (
    work: () => Promise<void>,
    place: 'dialog' | 'page' | 'general',
  ): Promise<void> => {
    setBusy(true);
    setNotice(null);
    setDialogProblem(null);
    setGeneralProblem(null);
    try {
      await work();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setDialog(null);
        setNotice({ tone: 'error', text: AGENDA_STALE_MESSAGE });
        setAttempt((value) => value + 1);
      } else if (place === 'general') {
        const own = agendaMessageOf(error);
        const text = own ?? settle(error);
        if (text !== null) setGeneralProblem(own === null ? SAVE_FAILED : text);
      } else {
        failure(error, place === 'dialog');
      }
    } finally {
      setBusy(false);
    }
  };

  const reload = (): void => setAttempt((value) => value + 1);

  const saveGeneral = (): Promise<void> =>
    run(async () => {
      const stepValue = Number(step);
      const noticeValue = Number(minNotice);
      const advanceValue = Number(maxAdvance);
      if (
        timezone.trim() === '' ||
        !SLOT_STEPS.includes(stepValue) ||
        !Number.isInteger(noticeValue) ||
        noticeValue < 0 ||
        noticeValue > 10_080 ||
        !Number.isInteger(advanceValue) ||
        advanceValue < 1 ||
        advanceValue > 365
      ) {
        setGeneralProblem(
          'Confira os campos: fuso, passo, antecedência (0 a 10080) e dias (1 a 365).',
        );
        return;
      }
      await agendaApi.saveSettings(companyId, {
        timezone: timezone.trim(),
        slotStepMinutes: stepValue,
        minNoticeMinutes: noticeValue,
        maxAdvanceDays: advanceValue,
      });
      setNotice({ tone: 'success', text: 'Configurações salvas.' });
      reload();
    }, 'general');

  /** Só as opções da IA: o resto da configuração vai como já está salvo (não como está sendo editado). */
  const saveAi = (): Promise<void> =>
    run(async () => {
      if (settings === null) return;
      setAiProblem(null);
      try {
        // Relê as configurações antes de salvar: o PUT leva o objeto inteiro e outra aba pode ter mudado o resto.
        const fresh = await agendaApi.settings(companyId);
        await agendaApi.saveSettings(companyId, {
          timezone: fresh.timezone,
          slotStepMinutes: fresh.slotStepMinutes,
          minNoticeMinutes: fresh.minNoticeMinutes,
          maxAdvanceDays: fresh.maxAdvanceDays,
          aiBookingEnabled: aiEnabled,
          aiAutoConfirm: aiEnabled && aiAuto,
        });
      } catch (error) {
        const own = agendaMessageOf(error);
        if (own === null) throw error;
        setAiProblem(own);
        return;
      }
      setNotice({ tone: 'success', text: 'Opções da IA salvas.' });
      reload();
    }, 'page');

  const saveService = (
    service: AgendaService | null,
    values: { name: string; durationMinutes: number; bufferMinutes: number },
  ): Promise<void> =>
    run(async () => {
      if (service === null) await agendaApi.createService(companyId, values);
      else await agendaApi.patchService(companyId, service.id, values);
      setDialog(null);
      setNotice({ tone: 'success', text: 'Serviço salvo.' });
      reload();
    }, 'dialog');

  const toggleService = (service: AgendaService): Promise<void> =>
    run(async () => {
      await agendaApi.patchService(companyId, service.id, { active: !service.active });
      setNotice({
        tone: 'success',
        text: service.active
          ? 'Serviço desativado. Os agendamentos existentes continuam; ele deixa de ser oferecido.'
          : 'Serviço reativado.',
      });
      reload();
    }, 'page');

  const saveResource = (resource: AgendaResource | null, name: string): Promise<void> =>
    run(async () => {
      if (resource === null) await agendaApi.createResource(companyId, name);
      else await agendaApi.patchResource(companyId, resource.id, { name });
      setDialog(null);
      setNotice({ tone: 'success', text: 'Recurso salvo.' });
      reload();
    }, 'dialog');

  const toggleResource = (resource: AgendaResource): Promise<void> =>
    run(async () => {
      await agendaApi.patchResource(companyId, resource.id, { active: !resource.active });
      setNotice({
        tone: 'success',
        text: resource.active ? 'Recurso desativado.' : 'Recurso reativado.',
      });
      reload();
    }, 'page');

  const loadSample = (): Promise<void> =>
    run(async () => {
      await agendaApi.loadSample(companyId);
      setNotice({
        tone: 'success',
        text: 'Exemplo carregado: serviço “Corte de cabelo” e horários de segunda a sexta, das 9h às 18h.',
      });
      reload();
    }, 'page');

  const removeSample = (): Promise<void> =>
    run(async () => {
      await agendaApi.removeSample(companyId);
      setNotice({ tone: 'success', text: 'Exemplo removido.' });
      reload();
    }, 'page');

  const saveRules = (resource: AgendaResource, windows: AgendaWindow[]): Promise<void> =>
    run(async () => {
      await agendaApi.saveRules(companyId, resource.id, windows);
      setDialog(null);
      setNotice({ tone: 'success', text: 'Horários salvos.' });
      reload();
    }, 'dialog');

  if (loadError !== null) {
    return (
      <div className="grid gap-4">
        <Problem text={loadError} />
        <div>
          <Button variant="outline" size="sm" onClick={reload}>
            Tentar de novo
          </Button>
        </div>
      </div>
    );
  }
  if (settings === null) {
    return (
      <div className="grid place-items-center gap-3 py-10 text-sm text-muted-foreground">
        <Loader variant="spinner" size={28} label="Carregando a configuração" />
        <span aria-hidden="true">Carregando a configuração…</span>
      </div>
    );
  }

  const single = resources.length <= 1;
  // Exemplo: carrega quando não há serviço seu nem exemplo ativo; remove quando há exemplo ativo.
  const showLoad = services.every((service) => service.isSample && !service.active);
  const showRemove = services.some((service) => service.isSample && service.active);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 text-xl font-semibold">Configurar agenda</h2>
        <Button variant="outline" size="sm" onClick={onBack}>
          Voltar à agenda
        </Button>
      </div>
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

      {(showLoad || showRemove) && (
        <section
          className="grid gap-2 rounded-2xl border border-border bg-muted p-3"
          aria-label="Exemplo"
        >
          {showLoad ? (
            <>
              <p className="m-0 text-sm text-foreground">
                Quer ver funcionando? Carregue um exemplo: um serviço de 30 minutos e horários de
                segunda a sexta, das 9h às 18h. Você pode remover depois.
              </p>
              <div>
                <Button size="sm" disabled={busy} onClick={() => void loadSample()}>
                  Carregar exemplo
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="m-0 text-sm text-foreground">
                Os dados de exemplo estão carregados. Remover desativa o serviço de exemplo e limpa
                os horários do exemplo.
              </p>
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void removeSample()}
                >
                  Remover exemplo
                </Button>
              </div>
            </>
          )}
        </section>
      )}

      <section className="grid gap-3" aria-labelledby="cfg-geral">
        <h3 id="cfg-geral" className="m-0 text-lg font-semibold">
          Geral
        </h3>
        <Problem text={generalProblem} />
        <Field id="cfg-passo" label="Passo entre horários (minutos)">
          <select
            id="cfg-passo"
            className={FIELD_CLASS}
            value={step}
            onChange={(event) => setStep(event.target.value)}
          >
            {SLOT_STEPS.map((value) => (
              <option key={value} value={String(value)}>
                {String(value)}
              </option>
            ))}
          </select>
        </Field>
        <Input
          label="Antecedência mínima (minutos)"
          inputMode="numeric"
          value={minNotice}
          onChange={setMinNotice}
        />
        <Input
          label="Agendar com até quantos dias de antecedência"
          inputMode="numeric"
          value={maxAdvance}
          onChange={setMaxAdvance}
        />
        <div>
          <Button disabled={busy} onClick={() => void saveGeneral()}>
            {busy ? 'Aguarde…' : 'Salvar configurações'}
          </Button>
        </div>
      </section>

      <section className="grid gap-3" aria-labelledby="cfg-ia">
        <h3 id="cfg-ia" className="m-0 text-lg font-semibold">
          IA no WhatsApp
        </h3>
        <Problem text={aiProblem} />
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-5 shrink-0"
            checked={aiEnabled}
            onChange={(event) => {
              setAiEnabled(event.target.checked);
              if (!event.target.checked) setAiAuto(false);
            }}
          />
          <span>
            A IA pode solicitar, cancelar e remarcar horários para quem escreve no WhatsApp
          </span>
        </label>
        <label
          className={`flex items-start gap-2 text-sm ${aiEnabled ? '' : 'text-muted-foreground'}`}
        >
          <input
            type="checkbox"
            className="mt-0.5 size-5 shrink-0"
            checked={aiAuto}
            disabled={!aiEnabled}
            onChange={(event) => setAiAuto(event.target.checked)}
          />
          <span>Confirmar automaticamente (sem passar pela equipe)</span>
        </label>
        <p className="m-0 text-sm text-muted-foreground">
          A IA só mexe nos agendamentos do próprio contato, respeitando os horários, o passo e a
          antecedência desta agenda, e nunca passa de 2 agendamentos ativos por contato. O contato
          não é avisado quando a equipe confirma ou cancela depois; por isso existe a confirmação
          automática. Sem ela, os pedidos da IA ficam aguardando a confirmação da equipe. Só vale
          com a IA de agenda ativada no servidor.
        </p>
        <div>
          <Button disabled={busy} onClick={() => void saveAi()}>
            {busy ? 'Aguarde…' : 'Salvar opções da IA'}
          </Button>
        </div>
      </section>

      <section className="grid gap-3" aria-labelledby="cfg-servicos">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="cfg-servicos" className="m-0 text-lg font-semibold">
            Serviços
          </h3>
          <Button
            size="sm"
            onClick={() => {
              setDialogProblem(null);
              setDialog({ kind: 'service', service: null });
            }}
          >
            Novo serviço
          </Button>
        </div>
        {services.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">
            Nenhum serviço ainda. Crie o primeiro para poder agendar.
          </p>
        ) : (
          <ul className="m-0 grid list-none gap-2 p-0">
            {services.map((service) => (
              <li
                key={service.id}
                className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card p-3 text-sm text-card-foreground ${service.active ? '' : 'opacity-70'}`}
              >
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <strong>{service.name}</strong> · {String(service.durationMinutes)} min
                  {service.bufferMinutes > 0
                    ? ` + ${String(service.bufferMinutes)} min de intervalo`
                    : ''}
                  {service.active ? '' : ' · Desativado'}
                </span>
                <span className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    aria-label={`Editar ${service.name}`}
                    onClick={() => {
                      setDialogProblem(null);
                      setDialog({ kind: 'service', service });
                    }}
                  >
                    Editar
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    aria-label={`${service.active ? 'Desativar' : 'Reativar'} ${service.name}`}
                    onClick={() => void toggleService(service)}
                  >
                    {service.active ? 'Desativar' : 'Reativar'}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-3" aria-labelledby="cfg-recursos">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="cfg-recursos" className="m-0 text-lg font-semibold">
            {single ? 'Horários de atendimento' : 'Profissionais, recursos e horários'}
          </h3>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setDialogProblem(null);
              setDialog({ kind: 'resource', resource: null });
            }}
          >
            Adicionar profissional ou recurso
          </Button>
        </div>
        <ul className="m-0 grid list-none gap-2 p-0">
          {resources.map((resource) => (
            <li
              key={resource.id}
              className={`grid gap-2 rounded-xl border border-border bg-card p-3 text-sm text-card-foreground ${resource.active ? '' : 'opacity-70'}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <strong>{resource.name}</strong>
                  {resource.active ? '' : ' · Desativado'}
                </span>
                <span className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    aria-label={`Horários de ${resource.name}`}
                    onClick={() => {
                      setDialogProblem(null);
                      setDialog({ kind: 'rules', resource });
                    }}
                  >
                    Horários
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    aria-label={`Renomear ${resource.name}`}
                    onClick={() => {
                      setDialogProblem(null);
                      setDialog({ kind: 'resource', resource });
                    }}
                  >
                    Renomear
                  </Button>
                  {!single && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      aria-label={`${resource.active ? 'Desativar' : 'Reativar'} ${resource.name}`}
                      onClick={() => void toggleResource(resource)}
                    >
                      {resource.active ? 'Desativar' : 'Reativar'}
                    </Button>
                  )}
                </span>
              </div>
              {resource.windows.length === 0 && (
                <p className="m-0 text-muted-foreground">
                  Sem horários: nenhum horário livre será oferecido até você configurar.
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>

      <Modal
        open={dialog?.kind === 'service'}
        title={
          dialog?.kind === 'service' && dialog.service !== null ? 'Editar serviço' : 'Novo serviço'
        }
        onClose={() => setDialog(null)}
      >
        {dialog?.kind === 'service' && (
          <ServiceForm
            key={dialog.service?.id ?? 'novo'}
            service={dialog.service}
            busy={busy}
            problem={dialogProblem}
            onSubmit={(values) => void saveService(dialog.service, values)}
          />
        )}
      </Modal>
      <Modal
        open={dialog?.kind === 'resource'}
        title={
          dialog?.kind === 'resource' && dialog.resource !== null
            ? 'Renomear'
            : 'Novo profissional ou recurso'
        }
        onClose={() => setDialog(null)}
      >
        {dialog?.kind === 'resource' && (
          <ResourceForm
            key={dialog.resource?.id ?? 'novo'}
            resource={dialog.resource}
            busy={busy}
            problem={dialogProblem}
            onSubmit={(name) => void saveResource(dialog.resource, name)}
          />
        )}
      </Modal>
      <Modal
        open={dialog?.kind === 'rules'}
        title="Horários de atendimento"
        onClose={() => setDialog(null)}
      >
        {dialog?.kind === 'rules' && (
          <RulesForm
            key={dialog.resource.id}
            resource={dialog.resource}
            busy={busy}
            problem={dialogProblem}
            onSubmit={(windows) => void saveRules(dialog.resource, windows)}
          />
        )}
      </Modal>
    </div>
  );
}
