import { z } from 'zod';

/**
 * O Prisma 7 não expõe mais `Prisma.dmmf`; o equivalente é o modelo de dados que o próprio
 * client gerado carrega em `_runtimeDataModel` (API interna, por isso lida aqui, em um só
 * lugar, com a forma validada: se uma atualização do Prisma mudar isso, falha alto).
 */
const runtimeDataModelSchema = z.object({
  models: z.record(
    z.string(),
    z.object({
      fields: z.array(z.object({ name: z.string(), kind: z.string(), type: z.string() })),
    }),
  ),
});

export interface FieldInfo {
  readonly name: string;
  /** `scalar`, `enum` ou `object` (relação). */
  readonly kind: string;
  /** Tipo do campo; em relações, o nome do model de destino. */
  readonly type: string;
}

export interface ModelInfo {
  readonly name: string;
  readonly fields: readonly FieldInfo[];
}

export function readModels(client: object): readonly ModelInfo[] {
  const parsed = runtimeDataModelSchema.safeParse(
    (client as { readonly _runtimeDataModel?: unknown })._runtimeDataModel,
  );
  if (!parsed.success) {
    throw new Error(
      'Não foi possível ler o modelo de dados do Prisma Client (_runtimeDataModel mudou?)',
    );
  }
  return Object.entries(parsed.data.models).map(([name, model]) => ({
    name,
    fields: model.fields,
  }));
}
