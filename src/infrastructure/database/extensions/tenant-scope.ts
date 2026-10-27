import type { ITXClientDenyList } from '@prisma/client/runtime/client';
import type { Prisma, PrismaClient } from '../../../generated/prisma/client.js';
import { TenantScopeError } from '../../../shared/errors/index.js';
import { type ModelInfo, readModels } from './schema-info.js';

/**
 * Segunda barreira do isolamento entre clientes (a primeira é a base de repositório, a
 * terceira é o lint). Todo model do Prisma é de **tenant** (tem `clientId`) ou **global**
 * (a raiz do tenant e o que não pertence a cliente algum). O compilador exige que a tabela
 * abaixo cubra todos os models; o teste de cobertura confere que a classificação bate com
 * a presença de `clientId` no schema.
 */
export type ModelScope = 'tenant' | 'global';

export const MODEL_SCOPES = {
  Client: 'global',
  Conversation: 'tenant',
  Message: 'tenant',
} as const satisfies Record<Prisma.ModelName, ModelScope>;

/** Operações de model que carregam um `where` que pode (e precisa) conter `clientId`. */
const OPERATIONS_WITH_WHERE: ReadonlySet<string> = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'updateManyAndReturn',
  'deleteMany',
]);

const CREATE_OPERATIONS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
]);

const UPDATE_OPERATIONS: ReadonlySet<string> = new Set(['updateMany', 'updateManyAndReturn']);

/**
 * Operações que identificam o registro só por chave única (sem `clientId`) ou fazem as duas
 * coisas ao mesmo tempo (`upsert`). Proibidas em model de tenant; use `findFirst`,
 * `updateMany` e `deleteMany` com `clientId` no `where`.
 */
const FORBIDDEN_UNIQUE_OPERATIONS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'delete',
  'upsert',
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * `clientId` precisamente definido: uma string, ou `{ equals: string }`. `undefined` (que o
 * Prisma trata como "sem filtro"), `null`, `in`, `not` e afins não servem como escopo.
 */
function hasTenantValue(container: unknown): boolean {
  if (!isRecord(container) || !Object.hasOwn(container, 'clientId')) return false;
  const value = container.clientId;
  if (isNonEmptyString(value)) return true;
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, 'equals') &&
    isNonEmptyString(value.equals)
  );
}

export interface TenantScopeCheck {
  readonly model: string | undefined;
  readonly operation: string;
  readonly args: unknown;
}

export type TenantScopeGuard = (check: TenantScopeCheck) => void;

/** Divergências entre os models do schema e a tabela de classificação. Vazio = tudo certo. */
export function findScopeProblems(
  models: readonly ModelInfo[],
  scopes: Readonly<Record<string, ModelScope>>,
): readonly string[] {
  const problems: string[] = [];
  for (const model of models) {
    const hasClientId = model.fields.some(
      (field) => field.name === 'clientId' && field.kind === 'scalar',
    );
    const scope = Object.hasOwn(scopes, model.name) ? scopes[model.name] : undefined;
    if (scope === undefined) {
      problems.push(
        `model ${model.name} não está classificado em MODEL_SCOPES (${hasClientId ? 'tenant' : 'global'}?)`,
      );
    } else if (hasClientId && scope !== 'tenant') {
      problems.push(`model ${model.name} tem clientId e precisa ser "tenant", não "${scope}"`);
    } else if (!hasClientId && scope !== 'global') {
      problems.push(`model ${model.name} não tem clientId e precisa ser "global", não "${scope}"`);
    }
  }
  const known = new Set(models.map((model) => model.name));
  for (const name of Object.keys(scopes)) {
    if (!known.has(name)) problems.push(`MODEL_SCOPES lista ${name}, que não existe no schema`);
  }
  return problems;
}

/**
 * Monta a verificação de escopo. Falha na construção (e não só em runtime) se a tabela não
 * bate com o schema, para que um model novo precise ser classificado antes de qualquer uso.
 */
export function createTenantScopeGuard(
  models: readonly ModelInfo[],
  scopes: Readonly<Record<string, ModelScope>> = MODEL_SCOPES,
): TenantScopeGuard {
  const problems = findScopeProblems(models, scopes);
  if (problems.length > 0) {
    throw new Error(`Classificação de models inválida: ${problems.join('; ')}`);
  }

  const scopeOf = (model: string): ModelScope | undefined =>
    Object.hasOwn(scopes, model) ? scopes[model] : undefined;
  const fieldsOf = (model: string): ModelInfo['fields'] =>
    models.find((candidate) => candidate.name === model)?.fields ?? [];
  const tenantRelations = (model: string): ReadonlySet<string> =>
    new Set(
      fieldsOf(model)
        .filter((field) => field.kind === 'object' && scopeOf(field.type) === 'tenant')
        .map((field) => field.name),
    );

  function reject(check: TenantScopeCheck, reason: string): never {
    throw new TenantScopeError(
      `Operação ${check.operation} em ${check.model ?? '?'} sem escopo de cliente: ${reason}`,
      { context: { model: check.model, operation: check.operation, reason } },
    );
  }

  /** Num model global, ler um relacionamento para model de tenant atravessaria clientes. */
  function assertNoTenantRelationReads(
    check: TenantScopeCheck,
    model: string,
    args: unknown,
  ): void {
    if (!isRecord(args)) return;
    for (const section of [args.select, args.include]) {
      if (!isRecord(section)) continue;
      for (const [field, value] of Object.entries(section)) {
        if (value === false || value === undefined || value === null) continue;
        if (field === '_count') {
          const counted = tenantRelations(model);
          const touches =
            value === true
              ? counted.size > 0
              : isRecord(value) &&
                isRecord(value.select) &&
                Object.entries(value.select).some(
                  ([name, on]) => on !== false && on !== undefined && counted.has(name),
                );
          if (touches) reject(check, `_count de relacionamento de tenant a partir de ${model}`);
          continue;
        }
        if (tenantRelations(model).has(field)) {
          reject(check, `leitura do relacionamento de tenant ${model}.${field}`);
        }
        const target = fieldsOf(model).find((candidate) => candidate.name === field)?.type;
        if (target !== undefined && isRecord(value))
          assertNoTenantRelationReads(check, target, value);
      }
    }
  }

  return (check) => {
    const { model, operation, args } = check;
    if (model === undefined) return;
    const scope = scopeOf(model);
    if (scope === undefined) reject(check, 'model sem classificação');
    if (scope === 'global') {
      assertNoTenantRelationReads(check, model, args);
      return;
    }

    if (FORBIDDEN_UNIQUE_OPERATIONS.has(operation)) {
      reject(check, 'operação por chave única não carrega o filtro de cliente');
    }
    const body = isRecord(args) ? args : {};

    if (OPERATIONS_WITH_WHERE.has(operation)) {
      if (!hasTenantValue(body.where)) reject(check, 'where sem clientId');
      if (UPDATE_OPERATIONS.has(operation)) {
        const { data } = body;
        if (isRecord(data) && (Object.hasOwn(data, 'clientId') || Object.hasOwn(data, 'client'))) {
          reject(check, 'update não pode mudar o cliente do registro');
        }
      }
      return;
    }

    if (CREATE_OPERATIONS.has(operation)) {
      const rows: readonly unknown[] = Array.isArray(body.data) ? body.data : [body.data];
      const complete = rows.length > 0 && rows.every((row) => hasTenantValue(row));
      if (!complete) reject(check, 'dados de criação sem clientId');
      if (rows.some((row) => isRecord(row) && Object.hasOwn(row, 'client'))) {
        reject(check, 'criação por relacionamento (client) em vez de clientId');
      }
      return;
    }

    // Falha fechada: operação que esta barreira não conhece não passa em model de tenant.
    reject(check, 'operação não permitida em model de tenant');
  };
}

/**
 * Aplica a barreira ao client: toda operação de model passa pela verificação antes de ir
 * ao banco. Vale também dentro de transações (`$transaction` herda as extensões).
 */
export function extendWithTenantScope(client: PrismaClient) {
  const guard = createTenantScopeGuard(readModels(client));
  return client.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          guard({ model, operation, args });
          return query(args);
        },
      },
    },
  });
}

/** O `PrismaClient` com a segunda barreira: o único tipo de client que o resto do código vê. */
export type TenantScopedPrisma = ReturnType<typeof extendWithTenantScope>;

/** O que um repositório enxerga: o client estendido ou o de uma transação (mesma barreira). */
export type TenantScopedDb = Omit<TenantScopedPrisma, ITXClientDenyList>;
