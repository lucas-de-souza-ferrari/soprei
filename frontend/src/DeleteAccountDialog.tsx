import { useEffect, useId, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { Button } from './components/motion/button';
import { Input } from './components/motion/input';

/**
 * Mensagem da recusa de excluir a conta (spec 032, E7), escolhida só por `status` e `error.code`, nunca pelo
 * texto do servidor.
 */
export function deleteAccountMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Não foi possível excluir a conta. Tente novamente.';
  if (error.status === 401) return 'Senha incorreta. Confira e tente novamente.';
  if (error.status === 429) return 'Muitas tentativas. Aguarde antes de tentar novamente.';
  if (error.status === 409) {
    switch (error.code) {
      case 'COMPANY_OWNERSHIP':
        return 'Você é o único dono de uma empresa. Passe a propriedade para outra pessoa da equipe antes de excluir a conta.';
      case 'SUBSCRIPTION_ACTIVE':
        return 'Sua assinatura tem um período pago em vigor. Cancele a renovação na tela Assinatura antes de excluir a conta.';
      case 'ORDER_PENDING':
        return 'Há um pagamento em aberto. Espere ele vencer (até 48 horas) antes de excluir a conta.';
      default:
        break;
    }
  }
  return 'Não foi possível excluir a conta. Tente novamente mais tarde.';
}

/** A sessão do cookie ainda vale? Só um 401 diz que não; qualquer outra falha conta como viva. */
async function sessionAlive(): Promise<boolean> {
  try {
    await api('/auth/session');
    return true;
  } catch (error) {
    return !(error instanceof ApiError && error.status === 401);
  }
}

export interface DeleteAccountDialogProps {
  readonly open: boolean;
  /** A conta foi excluída: quem chama sai da conta. */
  readonly onDeleted: () => void;
  /** O cookie já não vale (sessão vencida ou encerrada): quem chama volta ao login. */
  readonly onSessionEnded: () => void;
  readonly onClose: () => void;
}

/**
 * "Excluir minha conta" (spec 032, E7): `<dialog>` nativo com a senha atual. O foco vai ao campo da senha,
 * Esc fecha sem excluir (menos durante o envio) e a senha some da memória ao fechar ou depois do envio.
 */
export function DeleteAccountDialog({
  open,
  onDeleted,
  onSessionEnded,
  onClose,
}: DeleteAccountDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const textId = useId();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
    if (!open) {
      setPassword('');
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    if (busy || password === '') return;
    setBusy(true);
    setError(null);
    try {
      await api('/account/delete', { password });
      setPassword('');
      onDeleted();
    } catch (failure) {
      setPassword('');
      // Revisão da E7: o 401 é o mesmo para senha errada e para cookie que já não vale. Só a sessão diz qual;
      // sem ela, a tela não insiste em "senha incorreta" (revisão da E7, I1).
      if (failure instanceof ApiError && failure.status === 401 && !(await sessionAlive())) {
        onSessionEnded();
        return;
      }
      setError(deleteAccountMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={textId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      className="m-auto w-[min(92vw,30rem)] rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-[0_20px_70px_var(--shadow)] backdrop:bg-foreground/50"
    >
      {open && (
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h2 id={titleId} className="m-0 text-xl font-semibold">
            Excluir minha conta
          </h2>
          <div id={textId} className="grid gap-2 text-sm text-muted-foreground">
            <p className="m-0">
              Seu e-mail e sua senha são removidos na hora e você perde o acesso a todas as
              empresas. Isso não pode ser desfeito.
            </p>
            <p className="m-0">
              Ficam, sem identificar você, os registros de cobrança exigidos por lei e o histórico
              das empresas. O mesmo e-mail pode criar uma conta nova depois, que começa do zero.
            </p>
          </div>
          <Input
            id="delete-account-password"
            label="Sua senha atual"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            required
            maxLength={128}
            autoFocus
            disabled={busy}
            error={error ?? undefined}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancelar
            </Button>
            <Button
              type="submit"
              className="bg-destructive text-background hover:bg-destructive/90"
              disabled={busy || password === ''}
            >
              {busy ? 'Excluindo…' : 'Excluir conta'}
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}
