import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { PasswordHasher } from '../../application/ports/password-hasher.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';

/** Parâmetros do scrypt (OWASP Password Storage Cheat Sheet: N = 2^17, r = 8, p = 1). */
export interface ScryptCost {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

export const DEFAULT_SCRYPT_COST: ScryptCost = { N: 2 ** 17, r: 8, p: 1 };

const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** `maxmem` do `crypto.scrypt`: o padrão (N = 2^17, r = 8) usa ~128 MiB. */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
/**
 * Cada hash usa ~128 MiB e o `scrypt` assíncrono ocupa o pool de threads do libuv: sem teto, uma
 * enxurrada de logins esgotaria a memória e travaria o resto do processo. Quem passa do teto
 * espera na fila (o rate limit por IP e o bloqueio por conta limitam o tamanho dela).
 */
export const MAX_CONCURRENT_HASHES = 2;
/**
 * Teto da fila de espera (spec 008): a fila cresce com os pedidos autenticados que pagam um hash
 * (login, criação de usuário, troca e redefinição de senha), e cada espera é uma requisição
 * pendurada. Passou do teto, o pedido falha na hora com `ServiceUnavailableError` (503), sem gastar
 * hash nem memória, em vez de enfileirar sem limite.
 */
export const MAX_QUEUED_HASHES = 32;

/** Faixa de parâmetros aceita ao **verificar** (um hash adulterado não pode pedir gigabytes). */
const MIN_N = 2 ** 10;
const MAX_MEMORY_BYTES = 192 * 1024 * 1024;
const MAX_R = 16;
const MAX_P = 4;
const PREFIX = 'scrypt';

export type ScryptDerive = (
  password: string,
  salt: Buffer,
  keyLength: number,
  cost: ScryptCost,
) => Promise<Buffer>;

const nodeScrypt: ScryptDerive = (password, salt, keyLength, cost) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyLength,
      { N: cost.N, r: cost.r, p: cost.p, maxmem: SCRYPT_MAXMEM },
      (error, key) => {
        if (error === null) resolve(key);
        else reject(error);
      },
    );
  });

export interface ScryptPasswordHasherOptions {
  /** Custo dos hashes novos. Os testes passam um custo baixo para não pagar 128 MiB por teste. */
  readonly cost?: ScryptCost;
  readonly maxConcurrent?: number;
  /** Pedidos esperando uma vaga além dos em execução; passou disso, 503. Padrão `MAX_QUEUED_HASHES`. */
  readonly maxQueued?: number;
  /** Só para os testes (contar a concorrência). */
  readonly derive?: ScryptDerive;
}

interface ParsedHash {
  readonly cost: ScryptCost;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parseInteger(value: string): number | undefined {
  return /^[1-9][0-9]{0,9}$/.test(value) ? Number(value) : undefined;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function isAcceptedCost({ N, r, p }: ScryptCost): boolean {
  return (
    N >= MIN_N &&
    (N & (N - 1)) === 0 &&
    r >= 1 &&
    r <= MAX_R &&
    p >= 1 &&
    p <= MAX_P &&
    128 * N * r <= MAX_MEMORY_BYTES
  );
}

function parseStoredHash(stored: string): ParsedHash | undefined {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return undefined;
  const [, nText, rText, pText, saltText, keyText] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const N = parseInteger(nText);
  const r = parseInteger(rText);
  const p = parseInteger(pText);
  if (N === undefined || r === undefined || p === undefined) return undefined;
  const cost = { N, r, p };
  if (!isAcceptedCost(cost)) return undefined;
  if (!BASE64.test(saltText) || !BASE64.test(keyText)) return undefined;
  const salt = Buffer.from(saltText, 'base64');
  const key = Buffer.from(keyText, 'base64');
  if (salt.length < 8 || salt.length > 64 || key.length < 16 || key.length > 64) return undefined;
  return { cost, salt, key };
}

/**
 * Hash de senha com `scrypt` do `node:crypto` (sem dependência nova nem módulo nativo). O valor
 * guardado leva os parâmetros: `scrypt$N$r$p$<sal b64>$<hash b64>`, o que permite aumentar o custo
 * depois. Comparação com `timingSafeEqual`. A senha nunca vai a log nem a erro.
 */
export class ScryptPasswordHasher implements PasswordHasher {
  private readonly cost: ScryptCost;
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly derive: ScryptDerive;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private dummy: Promise<string> | undefined;

  constructor(options: ScryptPasswordHasherOptions = {}) {
    this.cost = options.cost ?? DEFAULT_SCRYPT_COST;
    this.maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_HASHES;
    this.maxQueued = options.maxQueued ?? MAX_QUEUED_HASHES;
    this.derive = options.derive ?? nodeScrypt;
    if (this.maxConcurrent < 1) throw new RangeError('maxConcurrent precisa ser >= 1');
    if (!Number.isInteger(this.maxQueued) || this.maxQueued < 0) {
      throw new RangeError('maxQueued precisa ser um inteiro >= 0');
    }
    if (!isAcceptedCost(this.cost)) throw new RangeError('custo do scrypt fora da faixa aceita');
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const key = await this.limited(() => this.derive(password, salt, KEY_BYTES, this.cost));
    const { N, r, p } = this.cost;
    return [PREFIX, N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
  }

  async verify(password: string, storedHash: string): Promise<boolean> {
    const parsed = parseStoredHash(storedHash);
    if (parsed === undefined) return false;
    const key = await this.limited(() =>
      this.derive(password, parsed.salt, parsed.key.length, parsed.cost),
    );
    return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
  }

  dummyHash(): Promise<string> {
    this.dummy ??= this.hash(randomBytes(16).toString('hex')).catch((error: unknown) => {
      this.dummy = undefined;
      throw error;
    });
    return this.dummy;
  }

  private async limited<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      if (this.waiting.length >= this.maxQueued) {
        throw new ServiceUnavailableError('Serviço temporariamente indisponível', {
          context: { reason: 'hash_queue_full' },
        });
      }
      // A vaga é passada direto por quem termina (o contador não muda).
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    } else {
      this.active += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next === undefined) this.active -= 1;
      else next();
    }
  }
}
