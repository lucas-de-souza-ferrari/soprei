declare const brand: unique symbol;

/**
 * Tipo "marcado": evita misturar valores estruturalmente iguais, como `ClientId`
 * e `ConversationId`, que são ambos `string`. Crie-os por factory que valida.
 */
export type Brand<T, B extends string> = T & { readonly [brand]: B };
