import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ClientService } from '../../application/clients/client.service.js';
import { Result } from '../../shared/types/index.js';
import { InMemoryClientRepository } from '../../test-support/in-memory-client.repository.js';
import { createLogger } from '../logger/logger.js';
import { buildServer } from './server.js';

const SRC = fileURLToPath(new URL('..', new URL('..', import.meta.url)));

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'generated') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) found.push(path);
  }
  return found;
}

describe('ADMIN_API_KEY foi removida (spec 007)', () => {
  it('não existe mais na config, em buildServer, em index.ts nem como adminAuthHook', () => {
    assert.equal(existsSync(join(SRC, 'presentation/admin/admin-auth.hook.ts')), false);
    const offenders = sourceFiles(SRC).filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /ADMIN_API_KEY|adminAuthHook|admin-auth\.hook|apiKey:\s*admin/.test(text);
    });
    assert.deepEqual(offenders, []);
  });

  it('as rotas /admin sem o serviço de autenticação nunca sobem (nada de rota aberta)', () => {
    assert.throws(
      () =>
        buildServer({
          logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
          readiness: {
            database: () => Promise.resolve(Result.ok(undefined)),
            redis: () => Promise.resolve(Result.ok(undefined)),
          },
          admin: { clients: new ClientService(new InMemoryClientRepository()) },
        }),
      /exigem o serviço de autenticação/,
    );
  });
});
