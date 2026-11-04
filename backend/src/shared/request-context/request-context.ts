import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Contexto de uma requisição, lido pelo logger (mixin) para que todo log feito durante ela
 * saia com o mesmo `requestId` e, quando existirem, `companyId`, `actorId` e `operation`.
 *
 * Os ids são `string` de propósito: `shared` não importa de `domain`, então os branded types
 * (`CompanyId`...) não chegam aqui. O contexto serve a observabilidade e NÃO é fonte de
 * verdade de segurança: o `CompanyId` das operações de dados segue passado explicitamente.
 */
export interface RequestContext {
  readonly requestId: string;
  readonly companyId?: string;
  readonly actorId?: string;
  /** `"<MÉTODO> <padrão da rota>"`, ex.: `GET /admin/companies/:id`. */
  readonly operation?: string;
}

/** O store é mutável só por dentro deste módulo (pelos setters). */
type MutableRequestContext = { -readonly [K in keyof RequestContext]: RequestContext[K] };

const storage = new AsyncLocalStorage<MutableRequestContext>();

/** Cria um store novo para uma requisição; quem o abre guarda a referência para reentrar. */
export function createRequestContext(requestId: string): RequestContext {
  return { requestId };
}

/**
 * Executa `fn` (e tudo que ela inicia, inclusive depois de `await`) com `context` como o
 * contexto atual. O store é usado por referência: os setters o alteram no lugar.
 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Contexto da requisição atual, ou `undefined` fora de uma (boot, shutdown, jobs). */
export function getContext(): Readonly<RequestContext> | undefined {
  return storage.getStore();
}

function update(patch: Partial<RequestContext>): void {
  const store = storage.getStore();
  if (store !== undefined) Object.assign(store, patch);
}

/** Preenchido pela autenticação (specs futuras). No-op fora de uma requisição. */
export function setCompanyId(companyId: string): void {
  update({ companyId });
}

/** Preenchido pela autenticação (specs futuras). No-op fora de uma requisição. */
export function setActorId(actorId: string): void {
  update({ actorId });
}

export function setOperation(operation: string): void {
  update({ operation });
}
