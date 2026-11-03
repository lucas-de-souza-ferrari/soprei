import { createHmac } from 'node:crypto';

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

const HMAC: Readonly<Record<string, string>> = {
  HS256: 'sha256',
  HS384: 'sha384',
  HS512: 'sha512',
};

/**
 * JWT montado à mão (só para testes): deixa escolher o algoritmo do cabeçalho, o `typ` e as claims,
 * para provar que o `authenticate` recusa o que não é exatamente um access token do projeto. Não
 * importa a `jose` (o ESLint a restringe a `src/infrastructure/auth/`); assina com HMAC do Node.
 */
export function forgeJwt(options: {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly secret: string;
}): string {
  const signingInput = `${encode(options.header)}.${encode(options.payload)}`;
  const alg = options.header.alg;
  const algorithm = typeof alg === 'string' ? HMAC[alg] : undefined;
  const signature =
    algorithm === undefined
      ? ''
      : createHmac(algorithm, options.secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}
