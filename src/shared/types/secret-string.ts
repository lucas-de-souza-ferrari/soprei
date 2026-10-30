import { inspect } from 'node:util';

const REDACTED = '[redacted]';

/**
 * Invólucro de segredo em memória (spec 015): `String(s)`, template string, `JSON.stringify` e
 * `util.inspect` devolvem `[redacted]`; só `reveal()` dá o valor. Um `logger.info({ token })`
 * distraído não vaza o token.
 */
export class SecretString {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
