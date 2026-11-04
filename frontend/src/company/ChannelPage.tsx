import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { Alert, AlertContent, AlertDescription, AlertIcon } from '../components/motion/alert';
import { Button } from '../components/motion/button';
import { Input } from '../components/motion/input';
import { Loader } from '../components/motion/loader';
import { type ChannelSetup, type ChannelState, companyApi, isStillSelected } from './company-api';
import { parseSignupEvent } from './embedded-signup-event';
import {
  INITIAL_SIGNUP_STATE,
  stepSignup,
  type SignupFailure,
  type SignupInput,
  type SignupState,
} from './embedded-signup-state';
import { type FacebookApi, loadFacebookSdk, startFacebookLogin } from './facebook-sdk';

export const WABA_WARNING =
  'Uma conta do WhatsApp Business conecta a uma empresa só. Desconectar remove o acesso do Soprei à conta inteira, o que afeta qualquer número dela.';
const SDK_ERROR =
  'Não foi possível carregar a janela da Meta. Desative bloqueadores e tente de novo.';
const SIGNUP_FAILURES: Readonly<Record<SignupFailure, string>> = {
  timeout: 'Tempo esgotado. Tente de novo.',
  error: 'A Meta não concluiu a conexão. Tente de novo.',
  unsupported: 'Esse fluxo da Meta não é suportado aqui. Tente de novo escolhendo um número.',
  popup_blocked:
    'Seu navegador bloqueou a janela da Meta. Permita pop-ups para este site e tente de novo.',
};
const DISABLED_MESSAGE = 'O canal do WhatsApp não está habilitado neste ambiente.';
const NOT_CONFIGURED_MESSAGE = 'A conexão pelo site ainda não está configurada.';

type Notice = { tone: 'error' | 'info' | 'success'; text: string } | null;
type Status = 'loading' | 'ready' | 'disabled' | 'failed';

const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const formatDate = (iso: string | null): string | null => {
  if (iso === null) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : dateFormat.format(date);
};

/** O `code` do callback do `FB.login`: só vale se tem o formato que o servidor aceita. */
function codeOf(response: { authResponse?: { code?: unknown } | null }): string | null {
  const code = response.authResponse?.code;
  return typeof code === 'string' && /^[^\s\p{Cc}]{1,512}$/u.test(code) ? code : null;
}

export interface ChannelPageProps {
  readonly companyId: string;
  /** `channel:manage`: conectar, trocar e desconectar. Sem ele só se lê o estado. */
  readonly canManage: boolean;
  /** Falha com mensagem de tela (texto) ou tratada por quem chama (login, empresa trocada: `null`). */
  readonly settle: (error: unknown) => string | null;
  readonly onChanged: () => void;
}

export function ChannelPage({ companyId, canManage, settle, onChanged }: ChannelPageProps) {
  const [status, setStatus] = useState<Status>('loading');
  const [channel, setChannel] = useState<ChannelState | null>(null);
  const [setup, setSetup] = useState<ChannelSetup | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [sdk, setSdk] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [phase, setPhase] = useState<SignupState['phase']>('idle');
  const [confirming, setConfirming] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const generation = useRef(0);
  const machine = useRef<SignupState>(INITIAL_SIGNUP_STATE);
  const facebook = useRef<FacebookApi | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  // Toda resposta tardia (troca de empresa, desmontagem, ação nova) é descartada pelo contador.
  useEffect(() => {
    const stamp = generation;
    return () => {
      stamp.current++;
      machine.current = INITIAL_SIGNUP_STATE;
    };
  }, [companyId]);

  const report = useCallback(
    (error: unknown, stamp: number): void => {
      if (stamp !== generation.current) return;
      const text = settle(error);
      if (text !== null) setNotice({ tone: 'error', text });
    },
    [settle],
  );

  /** 404 numa rota de canal: a empresa mudou, ou o canal não está habilitado neste ambiente. */
  const notFound = useCallback(
    async (stamp: number): Promise<void> => {
      try {
        const same = await isStillSelected(companyId);
        if (stamp !== generation.current) return;
        if (same) setStatus('disabled');
        else onChanged();
      } catch (error) {
        report(error, stamp);
        if (stamp === generation.current) setStatus('failed');
      }
    },
    [companyId, onChanged, report],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const stamp = ++generation.current;
    try {
      const state = await companyApi.channel(companyId);
      const config = canManage ? await companyApi.setup(companyId) : null;
      if (stamp !== generation.current) return;
      setChannel(state);
      setSetup(config);
      setStatus('ready');
    } catch (error) {
      if (stamp !== generation.current) return;
      if (error instanceof ApiError && error.status === 404) {
        await notFound(stamp);
        return;
      }
      setStatus('failed');
      report(error, stamp);
    }
  }, [canManage, companyId, notFound, report]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Ao voltar para a aba, o estado é relido (outra aba pode ter conectado ou desconectado).
  useEffect(() => {
    const onVisible = (): void => {
      if (
        document.visibilityState === 'visible' &&
        !busy &&
        phase !== 'waiting' &&
        phase !== 'submitting'
      ) {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [busy, phase, refresh]);

  const submitSignup = useCallback(
    async (
      body: { code: string; wabaId: string; phoneNumberId: string },
      stamp: number,
    ): Promise<void> => {
      setBusy(true);
      try {
        const next = await companyApi.embeddedSignup(companyId, body);
        if (stamp !== generation.current) return;
        machine.current = stepSignup(
          machine.current,
          { type: 'submitted', ok: true },
          Date.now(),
        ).state;
        setPhase(machine.current.phase);
        setChannel(next);
        setExplaining(false);
        setNotice({
          tone: 'success',
          text: 'Número conectado. O assistente já pode responder nele.',
        });
      } catch (error) {
        if (stamp !== generation.current) return;
        machine.current = stepSignup(
          machine.current,
          { type: 'submitted', ok: false },
          Date.now(),
        ).state;
        setPhase(machine.current.phase);
        report(error, stamp);
      } finally {
        if (stamp === generation.current) setBusy(false);
      }
    },
    [companyId, report],
  );

  const dispatch = useCallback(
    (input: SignupInput): void => {
      const previous = machine.current;
      const { state, effect } = stepSignup(previous, input, Date.now());
      machine.current = state;
      setPhase(state.phase);
      if (previous.phase === 'waiting' && state.phase === 'cancelled') {
        setNotice({ tone: 'info', text: 'Conexão cancelada.' });
      } else if (previous.phase === 'waiting' && state.phase === 'failed' && state.failure) {
        setNotice({ tone: 'error', text: SIGNUP_FAILURES[state.failure] });
      }
      if (effect !== null) {
        void submitSignup(
          { code: effect.code, wabaId: effect.wabaId, phoneNumberId: effect.phoneNumberId },
          generation.current,
        );
      }
    },
    [submitSignup],
  );
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  // O ouvinte do popup e o relógio só existem enquanto uma tentativa está em andamento.
  useEffect(() => {
    if (phase !== 'waiting') return;
    const onMessage = (event: MessageEvent): void => {
      const parsed = parseSignupEvent(event.origin, event.data);
      if (parsed !== null) dispatchRef.current({ type: 'event', event: parsed });
    };
    window.addEventListener('message', onMessage);
    const timer = setInterval(() => dispatchRef.current({ type: 'tick' }), 1000);
    return () => {
      window.removeEventListener('message', onMessage);
      clearInterval(timer);
    };
  }, [phase]);

  // Clique 1: abre o painel explicativo e só então carrega o SDK (uma vez).
  const openExplanation = (): void => {
    setNotice(null);
    setExplaining(true);
    if (facebook.current !== null || sdk === 'loading' || setup?.embeddedSignup == null) return;
    setSdk('loading');
    const stamp = generation.current;
    loadFacebookSdk({
      appId: setup.embeddedSignup.appId,
      graphApiVersion: setup.embeddedSignup.graphApiVersion,
    })
      .then((fb) => {
        if (stamp !== generation.current) return;
        facebook.current = fb;
        setSdk('ready');
      })
      .catch(() => {
        if (stamp !== generation.current) return;
        setSdk('error');
        setNotice({ tone: 'error', text: SDK_ERROR });
      });
  };

  // Clique 2: o `FB.login` roda de forma síncrona aqui, sem nenhum `await` antes (popup).
  const continueToMeta = (): void => {
    const fb = facebook.current;
    const embedded = setup?.embeddedSignup;
    if (fb === null || embedded == null || phase === 'waiting' || phase === 'submitting') return;
    setNotice(null);
    dispatch({ type: 'start' });
    const { popupBlocked } = startFacebookLogin(
      fb,
      {
        config_id: embedded.configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {} },
      },
      (response) => dispatchRef.current({ type: 'code', code: codeOf(response) }),
    );
    if (popupBlocked) dispatch({ type: 'popup_blocked' });
  };

  const retrySdk = (): void => {
    setSdk('idle');
    setNotice(null);
    facebook.current = null;
    openExplanation();
  };

  const disconnect = async (): Promise<void> => {
    const stamp = ++generation.current;
    dialog.current?.close();
    setConfirming(false);
    setBusy(true);
    setNotice(null);
    try {
      await companyApi.disconnect(companyId);
      if (stamp !== generation.current) return;
      setChannel((current) =>
        current === null
          ? current
          : {
              state: 'NOT_CONNECTED',
              phoneNumberId: null,
              wabaId: null,
              tokenExpiresAt: null,
              connectedAt: null,
              tokenInvalidAt: null,
            },
      );
      setNotice({ tone: 'success', text: 'Número desconectado.' });
    } catch (error) {
      report(error, stamp);
    } finally {
      if (stamp === generation.current) setBusy(false);
    }
  };

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (confirming && !element.open) element.showModal();
    if (!confirming && element.open) element.close();
  }, [confirming]);

  const [form, setForm] = useState({ phoneNumberId: '', wabaId: '', accessToken: '' });
  const [formError, setFormError] = useState<{ field: string; text: string } | null>(null);
  const manualConnect = async (): Promise<void> => {
    setFormError(null);
    const numeric = /^[0-9]{1,32}$/;
    if (!numeric.test(form.phoneNumberId)) {
      setFormError({ field: 'phoneNumberId', text: 'Informe só dígitos (até 32).' });
      return;
    }
    if (!numeric.test(form.wabaId)) {
      setFormError({ field: 'wabaId', text: 'Informe só dígitos (até 32).' });
      return;
    }
    if (!/^[^\s\p{Cc}]{20,1024}$/u.test(form.accessToken)) {
      setFormError({
        field: 'accessToken',
        text: 'O token tem de 20 a 1024 caracteres, sem espaços.',
      });
      return;
    }
    const stamp = ++generation.current;
    const body = { ...form };
    // O token sai da memória da tela assim que é enviado, com sucesso ou erro.
    setForm((current) => ({ ...current, accessToken: '' }));
    setBusy(true);
    setNotice(null);
    try {
      const next = await companyApi.manualConnect(companyId, body);
      if (stamp !== generation.current) return;
      setChannel(next);
      setForm({ phoneNumberId: '', wabaId: '', accessToken: '' });
      setAdvanced(false);
      setNotice({
        tone: 'success',
        text: 'Número conectado. O assistente já pode responder nele.',
      });
    } catch (error) {
      report(error, stamp);
    } finally {
      if (stamp === generation.current) setBusy(false);
    }
  };

  const working = busy || phase === 'waiting' || phase === 'submitting';
  const embedded = setup?.embeddedSignup ?? null;
  const state = channel?.state ?? 'NOT_CONNECTED';

  const alert = notice && (
    <div aria-live="polite">
      <Alert variant={notice.tone === 'error' ? 'destructive' : notice.tone}>
        <AlertIcon />
        <AlertContent>
          <AlertDescription className="text-inherit">{notice.text}</AlertDescription>
        </AlertContent>
      </Alert>
    </div>
  );

  if (status === 'loading') {
    return (
      <div className="grid place-items-center gap-3 py-10 text-sm text-muted-foreground">
        <Loader variant="spinner" size={28} label="Carregando o canal" />
        <span aria-hidden="true">Carregando o canal…</span>
      </div>
    );
  }
  if (status === 'disabled') {
    return <p className="py-2 text-muted-foreground">{DISABLED_MESSAGE}</p>;
  }
  if (status === 'failed' || channel === null) {
    return (
      <div className="grid gap-4">
        {alert}
        <div>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            Tentar de novo
          </Button>
        </div>
      </div>
    );
  }

  const connectedAt = formatDate(channel.connectedAt);
  const expiresAt = formatDate(channel.tokenExpiresAt);
  const invalidAt = formatDate(channel.tokenInvalidAt);
  const reconnectLabel =
    state === 'CONNECTED'
      ? 'Trocar número ou renovar'
      : state === 'NOT_CONNECTED'
        ? 'Conectar com a Meta'
        : 'Reconectar';

  return (
    <div className="grid gap-5">
      {alert}
      <div className="grid gap-2">
        {state === 'NOT_CONNECTED' && (
          <p>
            <strong>Nenhum número conectado.</strong> Conecte o número do WhatsApp da empresa para o
            assistente responder as mensagens que chegarem nele.
          </p>
        )}
        {state === 'CONNECTED' && (
          <>
            <p>
              <strong>Conectado.</strong> O assistente responde as mensagens recebidas neste número.
            </p>
            <dl className="grid gap-1 text-sm">
              <div className="flex flex-wrap gap-2">
                <dt className="text-muted-foreground">ID do número:</dt>
                <dd className="m-0 [overflow-wrap:anywhere]">{channel.phoneNumberId}</dd>
              </div>
              {connectedAt && (
                <div className="flex flex-wrap gap-2">
                  <dt className="text-muted-foreground">Conectado desde:</dt>
                  <dd className="m-0">{connectedAt}</dd>
                </div>
              )}
              {expiresAt && (
                <div className="flex flex-wrap gap-2">
                  <dt className="text-muted-foreground">Autorização válida até:</dt>
                  <dd className="m-0">{expiresAt}</dd>
                </div>
              )}
            </dl>
          </>
        )}
        {state === 'TOKEN_INVALID' && (
          <Alert variant="warning">
            <AlertIcon />
            <AlertContent>
              <AlertDescription className="text-inherit">
                A Meta recusou o acesso. O assistente parou de responder neste número
                {invalidAt ? ` (desde ${invalidAt})` : ''}. Reconecte para continuar.
              </AlertDescription>
            </AlertContent>
          </Alert>
        )}
        {state === 'LEGACY' && (
          <Alert variant="warning">
            <AlertIcon />
            <AlertContent>
              <AlertDescription className="text-inherit">
                Este número usa a credencial antiga do Soprei. Reconecte para continuar.
              </AlertDescription>
            </AlertContent>
          </Alert>
        )}
      </div>

      {canManage && embedded === null && !setup?.manualConnect && (
        <p className="text-muted-foreground">{NOT_CONFIGURED_MESSAGE}</p>
      )}

      {canManage && !explaining && (
        <div className="flex flex-wrap gap-2">
          {embedded !== null && (
            <Button disabled={working} onClick={openExplanation}>
              {reconnectLabel}
            </Button>
          )}
          {state !== 'NOT_CONNECTED' && (
            <Button variant="outline" disabled={working} onClick={() => setConfirming(true)}>
              Desconectar
            </Button>
          )}
        </div>
      )}

      {canManage && embedded !== null && explaining && (
        <section
          aria-labelledby="explicacao-titulo"
          className="grid gap-3 rounded-2xl border border-border bg-card p-5"
        >
          <h3 id="explicacao-titulo" className="m-0 text-lg font-semibold">
            Conectar com a Meta
          </h3>
          <p className="m-0 text-sm">
            Uma janela da Meta vai abrir. Nela você escolhe a conta do WhatsApp Business e o número.
            Depois disso, o Soprei passa a responder as mensagens recebidas nesse número.
          </p>
          <p className="m-0 text-sm text-muted-foreground" id="aviso-waba">
            {WABA_WARNING}
          </p>
          {sdk === 'loading' && (
            <p className="m-0 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader variant="spinner" size={16} label="Carregando" />
              <span>Carregando…</span>
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={sdk !== 'ready' || working}
              aria-describedby="aviso-waba"
              onClick={continueToMeta}
            >
              {phase === 'waiting' || phase === 'submitting'
                ? 'Aguardando a Meta…'
                : 'Continuar na Meta'}
            </Button>
            {sdk === 'error' && (
              <Button variant="outline" onClick={retrySdk}>
                Tentar carregar de novo
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={phase === 'submitting'}
              onClick={() => {
                dispatch({ type: 'reset' });
                setExplaining(false);
                setNotice(null);
              }}
            >
              Cancelar
            </Button>
          </div>
        </section>
      )}

      {canManage && setup?.manualConnect === true && (
        <section className="grid gap-3 border-t border-border pt-4">
          <div>
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={advanced}
              aria-controls="avancado"
              onClick={() => setAdvanced(!advanced)}
            >
              Avançado (testes)
            </Button>
          </div>
          {advanced && (
            <form
              id="avancado"
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void manualConnect();
              }}
            >
              <p className="m-0 text-sm text-muted-foreground">
                Conexão manual para testes (número de teste da Meta). Use o token do aplicativo do
                Soprei; ele não é guardado nesta tela.
              </p>
              <Input
                id="manual-phone-number-id"
                label="ID do número de telefone (Meta)"
                inputMode="numeric"
                autoComplete="off"
                value={form.phoneNumberId}
                onChange={(value) => setForm((current) => ({ ...current, phoneNumberId: value }))}
                maxLength={32}
                error={formError?.field === 'phoneNumberId' ? formError.text : undefined}
              />
              <Input
                id="manual-waba-id"
                label="ID da conta do WhatsApp Business (WABA)"
                inputMode="numeric"
                autoComplete="off"
                value={form.wabaId}
                onChange={(value) => setForm((current) => ({ ...current, wabaId: value }))}
                maxLength={32}
                error={formError?.field === 'wabaId' ? formError.text : undefined}
              />
              <Input
                id="manual-access-token"
                label="Token de acesso"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={form.accessToken}
                onChange={(value) => setForm((current) => ({ ...current, accessToken: value }))}
                maxLength={1024}
                error={formError?.field === 'accessToken' ? formError.text : undefined}
              />
              <Button type="submit" disabled={working}>
                Conectar manualmente
              </Button>
            </form>
          )}
        </section>
      )}

      <dialog
        ref={dialog}
        aria-labelledby="desconectar-titulo"
        aria-describedby="desconectar-texto"
        onClose={() => setConfirming(false)}
        className="m-auto w-[min(92vw,30rem)] rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-[0_20px_70px_var(--shadow)] backdrop:bg-black/50"
      >
        <div className="grid gap-4">
          <h3 id="desconectar-titulo" className="m-0 text-lg font-semibold">
            Desconectar o número?
          </h3>
          <p id="desconectar-texto" className="m-0 text-sm">
            O assistente deixa de responder neste número. {WABA_WARNING}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Cancelar
            </Button>
            <Button
              className="bg-destructive text-background hover:bg-destructive/90"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              Desconectar
            </Button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
