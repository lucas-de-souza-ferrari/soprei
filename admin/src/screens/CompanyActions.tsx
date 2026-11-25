import { useState, type ReactNode } from 'react';
import { ApiError } from '../api';
import { useAdmin } from '../admin-context';
import {
  ACTION_REASONS,
  MEMBERSHIP_ROLES,
  type ActionReason,
  type CompanyDetail,
  type MembershipRole,
  type Person,
} from '../contracts';
import { companyActionErrorMessage, label, normalizeCode } from '../format';
import { Alert, Button, Dialog, Select } from '../ui';

const FIELD = 'min-h-10 w-full rounded-md border border-input bg-card px-3 text-card-foreground';

/** O que um diálogo de ação precisa (regra comum 10 da spec 045). */
interface ActionSpec {
  readonly title: string;
  /** O efeito, em português, dito antes de confirmar. */
  readonly effect: string;
  readonly confirm: string;
  readonly danger: boolean;
  /** Pede o código novo do autenticador (**[código]**). */
  readonly code: boolean;
  /** O `POST` (caminho e corpo, sem `reason` e `code`, que o diálogo acrescenta). */
  readonly path: string;
  readonly body?: Record<string, unknown>;
  /** Nome da ação para a mensagem do 503 (o que grava e depois encerra sessões). */
  readonly kind: string;
  /** Campos próprios (nome novo, slug, papel); `ready` diz se o envio pode sair. */
  readonly fields?: ReactNode;
  readonly ready?: boolean;
}

/**
 * Um diálogo de ação da plataforma: efeito, motivo numa lista fixa, campos próprios e, nas ações
 * **[código]**, o código NOVO do autenticador (só no estado do diálogo, apagado a cada envio). Botão
 * ocupado durante o envio; erro só por `status` e `error.code`; 401 volta a Entrar; sucesso relê a tela.
 * Quem usa passa uma `key` por ação: cada diálogo aberto começa limpo (motivo padrão, sem código nem erro).
 */
function ActionDialog({
  spec,
  onClose,
  onDone,
}: {
  readonly spec: ActionSpec | null;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const { api, expire } = useAdmin();
  const [reason, setReason] = useState<ActionReason>('OWNER_REQUEST');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  async function confirm() {
    if (spec === null) return;
    setBusy(true);
    setError(undefined);
    const sent = code;
    setCode('');
    try {
      await api.post(spec.path, { ...spec.body, reason, ...(spec.code ? { code: sent } : {}) });
      onClose();
      onDone();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) return expire();
      setError(failure);
      // 503 depois de gravar (só faltou encerrar as sessões): relê para mostrar o estado real.
      if (failure instanceof ApiError && failure.status === 503) onDone();
    } finally {
      setBusy(false);
    }
  }

  const ready = (spec?.ready ?? true) && (spec?.code !== true || code.length === 6);
  return (
    <Dialog open={spec !== null} title={spec?.title ?? ''} busy={busy} onClose={onClose}>
      <p className="mb-3 text-sm">{spec?.effect}</p>
      <div className="flex flex-col gap-3">
        {spec?.fields}
        <Select<ActionReason>
          label="Motivo"
          value={reason}
          onChange={setReason}
          options={ACTION_REASONS.map((key) => [key, label(key)] as const)}
        />
        {spec?.code === true ? (
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
      {error === undefined ? null : <Alert>{companyActionErrorMessage(error, spec?.kind)}</Alert>}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button onClick={onClose} disabled={busy}>
          Cancelar
        </Button>
        <Button
          variant={spec?.danger === true ? 'danger' : 'primary'}
          onClick={() => void confirm()}
          disabled={busy || !ready}
        >
          {spec?.confirm ?? ''}
        </Button>
      </div>
    </Dialog>
  );
}

function TextInput({
  label: text,
  name,
  value,
  onChange,
  maxLength,
  hint,
}: {
  readonly label: string;
  readonly name: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly maxLength: number;
  readonly hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{text}</span>
      <input
        type="text"
        name={name}
        autoComplete="off"
        spellCheck={false}
        maxLength={maxLength}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={FIELD}
      />
      {hint === undefined ? null : <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

type CompanyAction = 'rename' | 'remove' | 'restore';

/**
 * Ações sobre a empresa (spec 045, E3a): renomear e remover (soft delete, com o slug digitado e o código)
 * nas não removidas; restaurar (com o código) nas removidas.
 */
export function CompanyActions({
  detail,
  onDone,
}: {
  readonly detail: CompanyDetail;
  readonly onDone: () => void;
}) {
  const [current, setCurrent] = useState<CompanyAction | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const base = `/platform/companies/${encodeURIComponent(detail.id)}`;
  const removed = detail.removedAt !== null;

  function open(next: CompanyAction) {
    setName(detail.name);
    setSlug('');
    setCurrent(next);
  }

  const specs: Record<CompanyAction, ActionSpec> = {
    rename: {
      title: 'Renomear a empresa?',
      effect: 'O nome muda para a equipe e para o admin na hora. O slug não muda.',
      confirm: 'Renomear',
      danger: false,
      code: false,
      path: `${base}/rename`,
      body: { name: name.trim() },
      kind: 'rename',
      ready: name.trim().length > 0 && name.trim().length <= 120,
      fields: (
        <TextInput
          label="Nome novo"
          name="company-name"
          value={name}
          onChange={setName}
          maxLength={120}
        />
      ),
    },
    remove: {
      title: `Remover ${detail.name}?`,
      effect:
        'A empresa some para a equipe na próxima requisição, o número do WhatsApp é liberado, a conexão do canal é apagada (a WABA inteira é desassinada) e os convites pendentes são revogados. Os dados ficam; dá para restaurar, mas o canal precisa ser reconectado pelo dono.',
      confirm: 'Confirmar remoção',
      danger: true,
      code: true,
      path: `${base}/remove`,
      body: { slug },
      kind: 'remove',
      ready: slug === detail.slug,
      fields: (
        <TextInput
          label={`Digite o slug da empresa (${detail.slug})`}
          name="company-slug"
          value={slug}
          onChange={setSlug}
          maxLength={63}
        />
      ),
    },
    restore: {
      title: `Restaurar ${detail.name}?`,
      effect:
        'A empresa volta a aparecer para a equipe. O canal não volta: o dono precisa reconectar o WhatsApp pelo site.',
      confirm: 'Confirmar restauração',
      danger: false,
      code: true,
      path: `${base}/restore`,
      kind: 'restore',
    },
  };

  return (
    <>
      {removed ? (
        <Button variant="primary" onClick={() => open('restore')}>
          Restaurar
        </Button>
      ) : (
        <>
          <Button onClick={() => open('rename')}>Renomear</Button>
          <Button variant="danger" onClick={() => open('remove')}>
            Remover empresa
          </Button>
        </>
      )}
      <ActionDialog
        key={current ?? 'fechado'}
        spec={current === null ? null : specs[current]}
        onClose={() => setCurrent(null)}
        onDone={onDone}
      />
    </>
  );
}

type MembershipAction = 'role' | 'disable' | 'enable';

/** Quais ações o vínculo admite (o servidor confere de novo as regras). */
export function availableMembershipActions(person: Pick<Person, 'status'>): MembershipAction[] {
  return ['role', person.status === 'ACTIVE' ? 'disable' : 'enable'];
}

/**
 * Ações sobre uma pessoa da empresa (spec 045, E3a): mudar o papel (com o código quando envolve dono) e
 * desativar ou reativar o vínculo ("remover da empresa" = desativar; o vínculo nunca é apagado).
 */
export function MembershipActions({
  detail,
  person,
  onDone,
}: {
  readonly detail: CompanyDetail;
  readonly person: Person;
  readonly onDone: () => void;
}) {
  const [current, setCurrent] = useState<MembershipAction | null>(null);
  const [role, setRole] = useState<MembershipRole>(person.role);
  const base = `/platform/companies/${encodeURIComponent(detail.id)}/memberships/${encodeURIComponent(person.membershipId)}`;
  const involvesOwner = person.role === 'OWNER' || role === 'OWNER';

  const specs: Record<MembershipAction, ActionSpec> = {
    role: {
      title: `Mudar o papel de ${person.emailMasked}?`,
      effect:
        'A pessoa passa a ter as permissões do papel novo na próxima requisição. Para transferir a propriedade, promova a outra pessoa a dono antes de rebaixar o dono atual.',
      confirm: 'Mudar papel',
      danger: involvesOwner,
      code: involvesOwner,
      path: `${base}/role`,
      body: { role },
      kind: 'role',
      ready: role !== person.role,
      fields: (
        <Select<MembershipRole>
          label="Papel novo"
          value={role}
          onChange={setRole}
          options={MEMBERSHIP_ROLES.map((key) => [key, label(key)] as const)}
        />
      ),
    },
    disable: {
      title: `Remover ${person.emailMasked} da empresa?`,
      effect:
        'O vínculo é desativado: a pessoa perde o acesso a esta empresa na próxima requisição (as outras empresas dela não mudam). Dá para reativar depois.',
      confirm: 'Desativar vínculo',
      danger: true,
      code: false,
      path: `${base}/disable`,
      kind: 'disable',
    },
    enable: {
      title: `Reativar ${person.emailMasked}?`,
      effect: 'A pessoa volta a acessar esta empresa com o papel que tinha.',
      confirm: 'Reativar vínculo',
      danger: false,
      code: false,
      path: `${base}/enable`,
      kind: 'enable',
    },
  };

  return (
    <>
      {availableMembershipActions(person).map((name) => (
        <Button
          key={name}
          variant={name === 'disable' ? 'danger' : 'secondary'}
          ariaLabel={`${name === 'role' ? 'Mudar papel' : name === 'disable' ? 'Desativar' : 'Reativar'} ${person.emailMasked}`}
          onClick={() => {
            setRole(person.role);
            setCurrent(name);
          }}
        >
          {name === 'role' ? 'Mudar papel' : name === 'disable' ? 'Desativar' : 'Reativar'}
        </Button>
      ))}
      <ActionDialog
        key={current ?? 'fechado'}
        spec={current === null ? null : specs[current]}
        onClose={() => setCurrent(null)}
        onDone={onDone}
      />
    </>
  );
}
