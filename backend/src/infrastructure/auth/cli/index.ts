import { createInterface } from 'node:readline';
import { loadConfig } from '../../config/index.js';
import { createDatabase, PrismaCompanyRepository } from '../../database/index.js';
import { createLogger } from '../../logger/logger.js';
import { createAuthRedis } from '../auth-redis.js';
import { createAuthComponents } from '../create-auth.js';
import { type AuthCliDeps, runAuthCli } from './auth-cli.js';

/** Lê uma linha do terminal sem eco (modo raw); Ctrl+C cancela. */
function readHidden(label: string): Promise<string> {
  const { stdin, stderr } = process;
  return new Promise<string>((resolve, reject) => {
    stderr.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const finish = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stderr.write('\n');
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          finish();
          reject(new Error('cancelado'));
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

/** Sem terminal (automação): a primeira linha do `stdin`. */
function readFirstLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin });
  return new Promise<string>((resolve) => {
    let done = false;
    rl.once('line', (line) => {
      done = true;
      rl.close();
      resolve(line);
    });
    rl.once('close', () => {
      if (!done) resolve('');
    });
  });
}

async function main(): Promise<number> {
  const config = loadConfig();
  const args = process.argv.slice(2);
  if (
    config.ACCOUNTS_ENABLED &&
    (args[0] === 'create-user' ||
      (args[0] === 'reset-password' && !args.includes('--platform-admin')))
  ) {
    process.stderr.write(
      'contas globais: criação e senha não são gerenciadas por empresa; use o cadastro da conta\n',
    );
    return 1;
  }
  // O logger fica mudo: o comando imprime só o id (nada de e-mail, senha ou hash em saída).
  const logger = createLogger({ NODE_ENV: config.NODE_ENV, LOG_LEVEL: 'silent' });
  const database = createDatabase(config, logger);
  const authRedis = createAuthRedis(config, logger);
  try {
    const auth = createAuthComponents({ config, logger, prisma: database.prisma, authRedis });
    const interactive = process.stdin.isTTY;
    const deps: AuthCliDeps = {
      companies: new PrismaCompanyRepository(database.prisma),
      memberships: auth.memberships,
      platformAdmins: auth.platformAdmins,
      hasher: auth.hasher,
      sessions: auth.sessions,
      interactive,
      readSecret: (label) => (interactive ? readHidden(label) : readFirstLine()),
      out: (line) => {
        process.stdout.write(`${line}\n`);
      },
      err: (line) => {
        process.stderr.write(`${line}\n`);
      },
    };
    return await runAuthCli(process.argv.slice(2), deps);
  } catch {
    // Mensagem fixa: o erro do driver ou do Redis pode carregar dado (consulta, chave).
    process.stderr.write('falha ao executar o comando (banco ou Redis indisponível?)\n');
    return 1;
  } finally {
    await database.close();
    await authRedis.close();
  }
}

process.exitCode = await main();
