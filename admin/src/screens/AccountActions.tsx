import { useState } from 'react';
import { ApiError } from '../api';
import { useAdmin } from '../admin-context';
import {
  ACCOUNT_ACTIONS,
  ACTION_REASONS,
  type AccountAction,
  type AccountDetail,
  type ActionReason,
} from '../contracts';
import { accountActionErrorMessage, label, normalizeCode } from '../format';
import { Alert, Button, Card, Dialog, Select } from '../ui';

const FIELD = 'min-h-10 w-full rounded-md border border-input bg-card px-3 text-card-foreground';

interface ActionCopy {
  readonly button: string;
  readonly title: string;
  /** O efeito, em português, dito antes de confirmar (regra comum 10). */
  readonly effect: string;
  readonly confirm: string;
  readonly danger: boolean;
  /** Aviso depois do sucesso (as respostas não têm corpo). */
  readonly done: string;
}

const COPY: Record<AccountAction, ActionCopy> = {
  disable: {
    button: 'Desativar conta',
    title: 'Desativar a conta?',
    effect:
      'A pessoa perde o acesso a todas as empresas na hora: as sessões abertas são encerradas e a entrada é recusada. Os vínculos com as empresas não mudam.',
    confirm: 'Confirmar desativação',
    danger: true,
    done: 'Conta desativada e sessões encerradas.',
  },
  enable: {
    button: 'Reativar conta',
    title: 'Reativar a conta?',
    effect:
      'A pessoa volta a poder entrar com a senha dela. As sessões encerradas não voltam e os vínculos não mudam.',
    confirm: 'Confirmar reativação',
    danger: false,
    done: 'Conta reativada.',
  },
  revokeSessions: {
    button: 'Encerrar sessões',
    title: 'Encerrar as sessões da conta?',
    effect:
      'Todas as sessões abertas da pessoa são encerradas na hora; ela continua podendo entrar com a senha.',
    confirm: 'Encerrar sessões',
    danger: true,
    done: 'Sessões encerradas.',
  },
  passwordReset: {
    button: 'Enviar código de recuperação de senha',
    title: 'Enviar código de recuperação de senha?',
    effect:
      'A pessoa recebe por e-mail um código para definir uma senha nova em "Esqueci a senha". Você não vê o código nem a senha. Se houve um pedido há menos de 60 s, nada sai.',
    confirm: 'Enviar código',
    danger: false,
    done: 'Pedido registrado: o código sai por e-mail se a conta estiver apta.',
  },
  resendVerification: {
    button: 'Reenviar código de confirmação',
    title: 'Reenviar o código de confirmação?',
    effect:
      'A pessoa recebe por e-mail um novo código de 6 dígitos para confirmar o endereço; o anterior deixa de valer. Se houve um envio há menos de 60 s, nada sai.',
    confirm: 'Reenviar código',
    danger: false,
    done: 'Pedido registrado: o código sai por e-mail se a conta estiver apta.',
  },
};

/** Quais ações a conta admite no estado em que está (o servidor confere de novo). */
export function availableAccountActions(
  detail: Pick<AccountDetail, 'status' | 'verified'>,
): AccountAction[] {
  const actions: AccountAction[] = [detail.status === 'ACTIVE' ? 'disable' : 'enable'];
  actions.push('revokeSessions');
  if (detail.verified && detail.status === 'ACTIVE') actions.push('passwordReset');
  if (!detail.verified) actions.push('resendVerification');
  return actions;
}

/**
 * Ações do admin sobre a conta (spec 045, E2): cada botão abre um diálogo que diz o efeito, pede o motivo
 * (lista fixa) e, em desativar, um código NOVO do autenticador. O código fica só no estado do diálogo e é
 * apagado a cada envio. Depois do sucesso, a tela relê o detalhe; o erro aparece pelo `status` e pelo
 * `error.code`, nunca pelo texto do servidor; 401 volta a Entrar.
 */
export function AccountActions({
  detail,
  onDone,
}: {
  readonly detail: AccountDetail;
  readonly onDone: () => void;
}) {
  const { api, expire } = useAdmin();
  const [current, setCurrent] = useState<AccountAction | null>(null);
  const [reason, setReason] = useState<ActionReason>('OWNER_REQUEST');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const action = current === null ? undefined : ACCOUNT_ACTIONS[current];
  const copy = current === null ? undefined : COPY[current];

  function open(next: AccountAction) {
    setCurrent(next);
    setReason('OWNER_REQUEST');
    setCode('');
    setError(undefined);
    setNotice(undefined);
  }

  async function confirm() {
    if (current === null || action === undefined || copy === undefined) return;
    setBusy(true);
    setError(undefined);
    const sent = code;
    setCode('');
    try {
      await api.post(`/platform/accounts/${encodeURIComponent(detail.id)}/${action.path}`, {
        reason,
        ...(action.code ? { code: sent } : {}),
      });
      setCurrent(null);
      setNotice(copy.done);
      onDone();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) return expire();
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  const needsCode = action?.code === true;
  const ready = !needsCode || code.length === 6;

  return (
    <Card title="Ações">
      <div className="flex flex-wrap gap-2">
        {availableAccountActions(detail).map((name) => (
          <Button
            key={name}
            variant={COPY[name].danger ? 'danger' : 'secondary'}
            onClick={() => open(name)}
          >
            {COPY[name].button}
          </Button>
        ))}
      </div>
      {notice === undefined ? null : <Alert tone="info">{notice}</Alert>}
      {/* Se o navegador fechar o diálogo à força no meio da ação, o erro aparece aqui fora. */}
      {current !== null || error === undefined ? null : (
        <Alert>{accountActionErrorMessage(error)}</Alert>
      )}
      <Dialog
        open={current !== null}
        title={copy?.title ?? ''}
        busy={busy}
        onClose={() => setCurrent(null)}
      >
        <p className="mb-3 text-sm">{copy?.effect}</p>
        <div className="flex flex-col gap-3">
          <Select<ActionReason>
            label="Motivo"
            value={reason}
            onChange={setReason}
            options={ACTION_REASONS.map((key) => [key, label(key)] as const)}
          />
          {needsCode ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Código novo do autenticador</span>
              <input
                type="text"
                name="confirmation-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                required
                value={code}
                onChange={(event) => setCode(normalizeCode(event.target.value))}
                className={`${FIELD} tracking-widest`}
              />
              <span className="text-xs text-muted-foreground">
                O código usado para entrar não vale de novo: espere o próximo (até 30 s).
              </span>
            </label>
          ) : null}
        </div>
        {error === undefined ? null : <Alert>{accountActionErrorMessage(error)}</Alert>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button onClick={() => setCurrent(null)} disabled={busy}>
            Cancelar
          </Button>
          <Button
            variant={copy?.danger === true ? 'danger' : 'primary'}
            onClick={() => void confirm()}
            disabled={busy || !ready}
          >
            {copy?.confirm ?? ''}
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}
