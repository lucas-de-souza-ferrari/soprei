import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError, request } from '../api';
import { Button } from '../components/motion/button';
import { Input } from '../components/motion/input';
import { Textarea } from '../components/textarea';
import {
  acceptedMessage,
  type DraftErrors,
  type DraftField,
  EMPTY_DRAFT,
  firstInvalid,
  parseFormToken,
  type SalesContactDraft,
  submitErrorMessage,
  toPayload,
  tokenErrorMessage,
  UNITS_OPTIONS,
  validateDraft,
  VOLUME_OPTIONS,
} from './sales-contact-rules';

const SELECT_CLASS =
  'h-12 w-full rounded-xl border border-input bg-background px-3 text-base text-foreground focus-visible:outline-3 focus-visible:outline-ring aria-[invalid=true]:border-destructive';

export interface SalesContactFormProps {
  /** Foco no primeiro campo ao abrir (o `Modal` procura `data-autofocus`). */
  readonly autoFocus?: boolean;
}

/**
 * Formulário de contato comercial (spec 040, E4): o mesmo componente na página pública `/fale-conosco` e no
 * cartão Enterprise da Assinatura. Não lê a sessão: as duas rotas são públicas. Tudo fica só em memória e é
 * limpo depois do envio aceito; o token do formulário (assinado pelo servidor) é pedido ao montar e de novo
 * depois de cada envio.
 */
export function SalesContactForm({ autoFocus = false }: SalesContactFormProps) {
  const [draft, setDraft] = useState<SalesContactDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [formToken, setFormToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const fields = useRef<Partial<Record<DraftField, HTMLElement | null>>>({});
  const prefix = useId();
  const id = (name: string) => `${prefix}-${name}`;

  const loadToken = useCallback(async () => {
    const current = ++generation.current;
    setFormToken(null);
    setTokenError(null);
    try {
      const token = parseFormToken(await request('/contact/sales/form-token'));
      if (current !== generation.current) return;
      if (token === null) setTokenError(tokenErrorMessage(500));
      else setFormToken(token);
    } catch (error) {
      if (current !== generation.current) return;
      setTokenError(tokenErrorMessage(error instanceof ApiError ? error.status : 0));
    }
  }, []);

  useEffect(() => {
    void loadToken();
    return () => {
      generation.current += 1;
    };
  }, [loadToken]);

  const update = <K extends keyof SalesContactDraft>(key: K, value: SalesContactDraft[K]) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    if (key !== 'website') setErrors((previous) => ({ ...previous, [key]: undefined }));
    setSuccess(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || formToken === null) return;
    const found = validateDraft(draft);
    setErrors(found);
    setSubmitError(null);
    const invalid = firstInvalid(found);
    if (invalid !== undefined) {
      fields.current[invalid]?.focus();
      return;
    }
    setBusy(true);
    try {
      const body = await request('/contact/sales', {
        method: 'POST',
        body: toPayload(draft, formToken),
      });
      setDraft(EMPTY_DRAFT);
      setErrors({});
      setSuccess(acceptedMessage(body));
      void loadToken();
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      const code = error instanceof ApiError ? error.code : undefined;
      setSubmitError(submitErrorMessage(status, code));
      if (status === 400 && code === 'FORM_EXPIRED') void loadToken();
    } finally {
      setBusy(false);
    }
  };

  const describedBy = (field: DraftField) =>
    errors[field] === undefined ? undefined : id(`${field}-erro`);
  const fieldError = (field: DraftField) =>
    errors[field] === undefined ? null : (
      <p id={id(`${field}-erro`)} className="m-0 px-1 text-sm text-destructive">
        {errors[field]}
      </p>
    );

  return (
    <form
      className="relative grid min-w-0 gap-4"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <Input
        ref={(element) => {
          fields.current.name = element;
        }}
        data-autofocus={autoFocus ? '' : undefined}
        label="Seu nome"
        autoComplete="name"
        value={draft.name}
        onChange={(value) => update('name', value)}
        maxLength={100}
        error={errors.name}
        required
      />
      <Input
        ref={(element) => {
          fields.current.email = element;
        }}
        label="E-mail"
        type="email"
        autoComplete="email"
        value={draft.email}
        onChange={(value) => update('email', value)}
        maxLength={254}
        error={errors.email}
        required
      />
      <Input
        ref={(element) => {
          fields.current.phone = element;
        }}
        label="Telefone ou WhatsApp (opcional)"
        type="tel"
        autoComplete="tel"
        value={draft.phone}
        onChange={(value) => update('phone', value)}
        maxLength={20}
        error={errors.phone}
      />
      <Input
        ref={(element) => {
          fields.current.companyName = element;
        }}
        label="Nome da empresa"
        autoComplete="organization"
        value={draft.companyName}
        onChange={(value) => update('companyName', value)}
        maxLength={120}
        error={errors.companyName}
        required
      />
      <div className="grid gap-1">
        <label htmlFor={id('unidades')} className="px-1 text-sm font-medium">
          Quantas empresas ou unidades?
        </label>
        <select
          id={id('unidades')}
          ref={(element) => {
            fields.current.units = element;
          }}
          className={SELECT_CLASS}
          value={draft.units}
          aria-invalid={errors.units === undefined ? undefined : true}
          aria-describedby={describedBy('units')}
          onChange={(event) => update('units', event.target.value as SalesContactDraft['units'])}
          required
        >
          <option value="">Escolha uma faixa</option>
          {UNITS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {fieldError('units')}
      </div>
      <div className="grid gap-1">
        <label htmlFor={id('volume')} className="px-1 text-sm font-medium">
          Volume estimado de mensagens
        </label>
        <select
          id={id('volume')}
          ref={(element) => {
            fields.current.monthlyVolume = element;
          }}
          className={SELECT_CLASS}
          value={draft.monthlyVolume}
          aria-invalid={errors.monthlyVolume === undefined ? undefined : true}
          aria-describedby={describedBy('monthlyVolume')}
          onChange={(event) =>
            update('monthlyVolume', event.target.value as SalesContactDraft['monthlyVolume'])
          }
          required
        >
          <option value="">Escolha uma faixa</option>
          {VOLUME_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {fieldError('monthlyVolume')}
      </div>
      <Textarea
        ref={(element: HTMLTextAreaElement | null) => {
          fields.current.message = element;
        }}
        label="Mensagem"
        hint="Conte um pouco sobre a sua operação e o que você procura."
        value={draft.message}
        onChange={(value) => update('message', value)}
        maxLength={2000}
        rows={5}
        error={errors.message}
        required
      />
      {/* Honeypot: fora da tela, do leitor de tela e da ordem de tabulação. Pessoas nunca o preenchem. */}
      <div
        aria-hidden="true"
        inert
        className="absolute -left-[9999px] top-0 h-px w-px overflow-hidden"
      >
        <label htmlFor={id('site')}>Site</label>
        <input
          id={id('site')}
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={draft.website}
          onChange={(event) => update('website', event.target.value)}
        />
      </div>
      <div className="grid gap-1">
        <label className="flex min-h-11 items-start gap-2 text-sm">
          <input
            ref={(element) => {
              fields.current.privacyAck = element;
            }}
            type="checkbox"
            className="mt-0.5 size-5 shrink-0"
            checked={draft.privacyAck}
            aria-invalid={errors.privacyAck === undefined ? undefined : true}
            aria-describedby={describedBy('privacyAck')}
            onChange={(event) => update('privacyAck', event.target.checked)}
          />
          <span>
            Li a{' '}
            <a href="/privacidade" target="_blank" rel="noreferrer" className="underline">
              Política de Privacidade
            </a>{' '}
            e entendo que estes dados serão usados para responder o meu pedido.
          </span>
        </label>
        {fieldError('privacyAck')}
      </div>
      <div aria-live="polite" className="grid gap-2">
        {tokenError !== null && (
          <p className="m-0 text-sm font-medium text-destructive" role="alert">
            {tokenError}
          </p>
        )}
        {submitError !== null && (
          <p className="m-0 text-sm font-medium text-destructive" role="alert">
            {submitError}
          </p>
        )}
        {success !== null && (
          <p className="m-0 text-sm font-medium" role="status" data-testid="contato-enviado">
            {success}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || formToken === null}>
          {busy ? 'Enviando…' : 'Enviar'}
        </Button>
        {tokenError !== null && (
          <Button type="button" variant="outline" onClick={() => void loadToken()}>
            Tentar de novo
          </Button>
        )}
      </div>
    </form>
  );
}
