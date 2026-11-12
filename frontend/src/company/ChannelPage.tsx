import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { Alert, AlertContent, AlertDescription, AlertIcon } from '../components/motion/alert';
import { Smartphone } from 'lucide-react';
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

/**
 * Spec 039 (E1): pré-requisitos da coexistência, conferidos pela própria pessoa antes de abrir a janela
 * da Meta (o site só orienta; não verifica nada). Texto revisto depois do E0: ser administrador do
 * portfólio NÃO impediu o fluxo, então não aparece como requisito nem como causa certa de erro.
 */
export const COEXISTENCE_CHECKLIST: readonly string[] = [
  'O aplicativo WhatsApp Business está atualizado e aberto no celular, com a câmera liberada (a Meta pode pedir para ler um QR code).',
  'Este número já é usado no aplicativo WhatsApp Business há alguns dias.',
  'Você consegue entrar no portfólio de negócios da Meta que vai escolher, ou vai criar um novo na janela da Meta.',
  'O número não está conectado a outra plataforma de atendimento nem a outra empresa do Soprei.',
  'Você tem uma forma de pagamento para cadastrar na Meta, se ela pedir.',
];
/** Spec 039 (D9): texto fixo de ajuda quando a conexão não termina; nunca afirma qual foi a causa. */
export const COEXISTENCE_UNFINISHED = 'A conexão não terminou.';
export const COEXISTENCE_HELP: readonly string[] = [
  'o número já está em uso em outra plataforma de atendimento;',
  'o aplicativo no celular está desatualizado ou fechado;',
  'a conta usada na janela da Meta não tem acesso ao portfólio ou à conta do WhatsApp Business escolhida.',
];
export const PERSONAL_WHATSAPP_HINT =
  'Usa o WhatsApp comum (não o Business)? Instale o WhatsApp Business no celular e migre o número antes de conectar.';
export const COEXISTENCE_CONNECTED_TEXT =
  'O número continua no aplicativo WhatsApp Business do celular. Quando alguém da equipe responde um contato pelo celular, a IA para de responder esse contato por 12 horas, ou até você reativar na conversa. Abra o aplicativo no celular de vez em quando: a Meta pode desconectar o número se ele ficar muito tempo sem uso.';

type ConnectChoice = 'coexistence' | 'api_only';
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
  // Spec 039: a escolha do fluxo, as caixas do checklist e a ajuda vivem só em memória.
  const [choice, setChoice] = useState<ConnectChoice | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const [help, setHelp] = useState(false);
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
      body: { code: string; wabaId: string; phoneNumberId?: string; mode?: 'coexistence' },
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
        setChoice(null);
        setChecked(new Set());
        setNotice({
          tone: 'success',
          text:
            body.mode === 'coexistence'
              ? 'Número conectado pelo aplicativo. O assistente já pode responder nele; quando a equipe responder pelo celular, a IA pausa naquele contato.'
              : 'Número conectado. O assistente já pode responder nele.',
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
        if (body.mode === 'coexistence') setHelp(true);
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
      const coexistence = state.mode === 'coexistence';
      if (previous.phase === 'waiting' && state.phase === 'cancelled') {
        setNotice({
          tone: 'info',
          text: coexistence ? COEXISTENCE_UNFINISHED : 'Conexão cancelada.',
        });
        if (coexistence) setHelp(true);
      } else if (previous.phase === 'waiting' && state.phase === 'failed' && state.failure) {
        setNotice({ tone: 'error', text: SIGNUP_FAILURES[state.failure] });
        if (coexistence && state.failure !== 'popup_blocked') setHelp(true);
      }
      if (effect !== null) {
        void submitSignup(
          {
            code: effect.code,
            wabaId: effect.wabaId,
            ...(effect.phoneNumberId === null ? {} : { phoneNumberId: effect.phoneNumberId }),
            ...(effect.mode === 'coexistence' ? { mode: 'coexistence' as const } : {}),
          },
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

  // Clique 1: abre o painel explicativo e só então carrega o SDK (uma vez). Spec 039: com a coexistência,
  // o clique é a escolha de um dos dois cartões.
  const openExplanation = (picked: ConnectChoice = 'api_only'): void => {
    setNotice(null);
    setHelp(false);
    setChoice(picked);
    setChecked(new Set());
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
    const coexistence = choice === 'coexistence';
    const coexistenceConfigId = setup?.coexistence.configId ?? null;
    if (coexistence && (coexistenceConfigId === null || !allChecked)) return;
    setNotice(null);
    setHelp(false);
    dispatch({ type: 'start', mode: coexistence ? 'coexistence' : 'api_only' });
    const { popupBlocked } = startFacebookLogin(
      fb,
      {
        config_id:
          coexistence && coexistenceConfigId !== null ? coexistenceConfigId : embedded.configId,
        response_type: 'code',
        override_default_response_type: true,
        // `featureType` só na coexistência (spec 039): o fluxo de número novo não muda.
        extras: coexistence
          ? { setup: {}, featureType: 'whatsapp_business_app_onboarding' }
          : { setup: {} },
      },
      (response) => dispatchRef.current({ type: 'code', code: codeOf(response) }),
    );
    if (popupBlocked) dispatch({ type: 'popup_blocked' });
  };

  const retrySdk = (): void => {
    setSdk('idle');
    setNotice(null);
    facebook.current = null;
    openExplanation(choice ?? 'api_only');
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
              mode: null,
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
  // Spec 039: a escolha só existe com a coexistência disponível no servidor (e o SDK configurado).
  const coexistenceAvailable =
    embedded !== null &&
    setup?.coexistence.available === true &&
    setup.coexistence.configId !== null;
  const allChecked = checked.size === COEXISTENCE_CHECKLIST.length;
  const toggleCheck = (index: number, on: boolean): void => {
    setChecked((current) => {
      const next = new Set(current);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });
  };
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
            {channel.mode === 'COEXISTENCE' && (
              <section
                aria-labelledby="coexistencia-titulo"
                className="grid gap-2 rounded-2xl border border-border bg-card p-4"
              >
                <h3
                  id="coexistencia-titulo"
                  className="m-0 flex items-center gap-2 text-base font-semibold"
                >
                  <Smartphone aria-hidden="true" className="size-4" />
                  Conectado pelo aplicativo
                </h3>
                <p className="m-0 text-sm">{COEXISTENCE_CONNECTED_TEXT}</p>
              </section>
            )}
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

      {canManage && !explaining && coexistenceAvailable && (
        <section aria-labelledby="escolha-titulo" className="grid gap-3">
          <h3 id="escolha-titulo" className="m-0 text-lg font-semibold">
            Como você quer conectar?
          </h3>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="grid content-start gap-2 rounded-2xl border border-border bg-card p-4">
              <p className="m-0 font-semibold">
                Uso o WhatsApp Business no celular e quero continuar usando
              </p>
              <p className="m-0 text-sm">
                Recomendado. O número continua no aplicativo do celular e você pode responder por
                lá. Quando a equipe responde um contato pelo celular, a IA para de responder esse
                contato por um tempo.
              </p>
              <p className="m-0 text-sm text-muted-foreground">{PERSONAL_WHATSAPP_HINT}</p>
              <div>
                <Button disabled={working} onClick={() => openExplanation('coexistence')}>
                  Conectar pelo aplicativo
                </Button>
              </div>
            </div>
            <div className="grid content-start gap-2 rounded-2xl border border-border bg-card p-4">
              <p className="m-0 font-semibold">Vou usar um número novo, só para o Soprei</p>
              <p className="m-0 text-sm">
                O número sai do aplicativo e fica só com o Soprei. A conta do WhatsApp Business é
                criada ou escolhida na janela da Meta.
              </p>
              <div>
                <Button
                  variant="outline"
                  disabled={working}
                  onClick={() => openExplanation('api_only')}
                >
                  Conectar um número novo
                </Button>
              </div>
            </div>
          </div>
        </section>
      )}

      {canManage && !explaining && (
        <div className="flex flex-wrap gap-2">
          {embedded !== null && !coexistenceAvailable && (
            <Button disabled={working} onClick={() => openExplanation('api_only')}>
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
            {choice === 'coexistence' ? 'Conectar pelo aplicativo' : 'Conectar com a Meta'}
          </h3>
          {choice === 'coexistence' ? (
            <>
              <p className="m-0 text-sm">
                Uma janela da Meta vai abrir. Nela você entra, escolhe o portfólio e a conta do
                WhatsApp Business e confirma o número do aplicativo. Antes, confira:
              </p>
              <fieldset className="m-0 grid gap-2 border-0 p-0">
                <legend className="mb-1 text-sm font-semibold">Antes de abrir a janela</legend>
                {COEXISTENCE_CHECKLIST.map((item, index) => (
                  <label key={item} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-5 shrink-0"
                      checked={checked.has(index)}
                      onChange={(event) => toggleCheck(index, event.target.checked)}
                    />
                    <span>{item}</span>
                  </label>
                ))}
              </fieldset>
            </>
          ) : (
            <p className="m-0 text-sm">
              Uma janela da Meta vai abrir. Nela você escolhe a conta do WhatsApp Business e o
              número. Depois disso, o Soprei passa a responder as mensagens recebidas nesse número.
            </p>
          )}
          <p className="m-0 text-sm text-muted-foreground" id="aviso-waba">
            {WABA_WARNING}
          </p>
          {help && choice === 'coexistence' && (
            <div className="grid gap-1 rounded-xl border border-border p-3 text-sm" role="note">
              <p className="m-0 font-semibold">{COEXISTENCE_UNFINISHED}</p>
              <p className="m-0">As causas mais comuns são (o site não sabe qual foi):</p>
              <ul className="m-0 grid gap-1 pl-5">
                {COEXISTENCE_HELP.map((cause) => (
                  <li key={cause}>{cause}</li>
                ))}
              </ul>
            </div>
          )}
          {sdk === 'loading' && (
            <p className="m-0 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader variant="spinner" size={16} label="Carregando" />
              <span>Carregando…</span>
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={sdk !== 'ready' || working || (choice === 'coexistence' && !allChecked)}
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
                setHelp(false);
                setChoice(null);
                setChecked(new Set());
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
