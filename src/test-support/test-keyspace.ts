import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * Chaves de Redis de um teste: prefixo único por instância e remoção só do que o teste
 * criou. Nunca limpa o banco inteiro (o Redis /15 pode ser compartilhado).
 */
export class TestKeyspace {
  private readonly prefix = `soprei:test:${randomUUID()}`;
  private readonly keys = new Set<string>();

  key(name: string): string {
    const key = `${this.prefix}:${name}`;
    this.keys.add(key);
    return key;
  }

  async cleanup(redis: Redis): Promise<void> {
    if (this.keys.size === 0) return;
    await redis.del(...this.keys);
    this.keys.clear();
  }
}
