import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * Chaves de Redis de um teste: prefixo único por instância e remoção só do que o teste
 * criou. Nunca limpa o banco inteiro (o Redis /15 pode ser compartilhado).
 */
export class TestKeyspace {
  private readonly prefix = `soprei:test:${randomUUID()}`;
  private readonly keys = new Set<string>();
  private readonly prefixes = new Set<string>();

  key(name: string): string {
    const key = `${this.prefix}:${name}`;
    this.keys.add(key);
    return key;
  }

  /**
   * Prefixo (com `:` final) para um componente que cria as próprias chaves sob ele (ex.: o
   * namespace do rate limit). O prefixo é único deste teste; `cleanup` remove, por `SCAN`, só
   * as chaves que começam com ele.
   */
  scopedPrefix(name: string): string {
    const prefix = `${this.prefix}:${name}:`;
    this.prefixes.add(prefix);
    return prefix;
  }

  /** Chaves existentes agora sob um prefixo deste teste (para inspeção: TTL, quantidade). */
  async keysUnder(redis: Redis, prefix: string): Promise<string[]> {
    if (!this.prefixes.has(prefix)) {
      throw new Error('prefixo não criado por este TestKeyspace');
    }
    return scan(redis, prefix);
  }

  async cleanup(redis: Redis): Promise<void> {
    const found = new Set(this.keys);
    for (const prefix of this.prefixes) {
      for (const key of await scan(redis, prefix)) found.add(key);
    }
    if (found.size > 0) await redis.del(...found);
    this.keys.clear();
    this.prefixes.clear();
  }
}

/** `SCAN MATCH <prefixo>*`: o prefixo tem só UUID, letras e `:` (sem metacaracteres de glob). */
async function scan(redis: Redis, prefix: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
    found.push(...batch);
    cursor = next;
  } while (cursor !== '0');
  return found;
}
