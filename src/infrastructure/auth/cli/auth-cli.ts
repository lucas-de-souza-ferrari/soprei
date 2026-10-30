import { parseArgs } from 'node:util';
import { z } from 'zod';
import { PLATFORM_SCOPE } from '../../../application/auth/identity.js';
import {
  clientSlugSchema,
  emailSchema,
  newPasswordSchema,
} from '../../../application/auth/credentials.js';
import type { PasswordHasher } from '../../../application/ports/password-hasher.js';
import type { SessionStore } from '../../../application/ports/session-store.js';
import {
  type ClientRepository,
  type PlatformAdminRepository,
  USER_ROLES,
  type UserRepository,
} from '../../../domain/index.js';
import { ConflictError, NotFoundError } from '../../../shared/errors/index.js';

/**
 * Comando local do dono para criar o primeiro usuário (spec 007). **A senha nunca vem por argumento
 * nem por variável de ambiente**: é pedida no terminal sem eco (digitada duas vezes) ou, sem
 * terminal, lida da primeira linha do `stdin`. Nada além do id é impresso: nem e-mail, nem senha,
 * nem hash. As mensagens de erro são constantes (não ecoam o que foi digitado).
 */
export interface AuthCliDeps {
  readonly clients: ClientRepository;
  readonly users: UserRepository;
  readonly platformAdmins: PlatformAdminRepository;
  readonly hasher: PasswordHasher;
  readonly sessions: SessionStore;
  /** Com terminal: pede a senha duas vezes e confere. Sem terminal: lê só a primeira linha. */
  readonly interactive: boolean;
  /** Lê um segredo sem eco (ou a primeira linha do `stdin`). `label` é só o texto do pedido. */
  readSecret(label: string): Promise<string>;
  out(line: string): void;
  err(line: string): void;
}

export const AUTH_CLI_USAGE = [
  'uso:',
  '  pnpm auth:cli create-platform-admin --email <e-mail>',
  '  pnpm auth:cli create-user --client <slug> --email <e-mail> --role OWNER|ADMIN|AGENT|VIEWER',
  '  pnpm auth:cli reset-password (--platform-admin | --client <slug>) --email <e-mail>',
  'A senha é pedida no terminal (sem eco); nunca por argumento nem por variável de ambiente.',
].join('\n');

const COMMANDS = ['create-platform-admin', 'create-user', 'reset-password'] as const;

const OPTIONS = {
  email: { type: 'string' },
  client: { type: 'string' },
  role: { type: 'string' },
  'platform-admin': { type: 'boolean' },
} as const;

class CliUsageError extends Error {}

const roleSchema = z.enum(USER_ROLES);

function fail(deps: AuthCliDeps, message: string): number {
  deps.err(message);
  return 1;
}

async function readNewPassword(deps: AuthCliDeps): Promise<string | undefined> {
  const first = await deps.readSecret('Senha: ');
  if (deps.interactive) {
    const second = await deps.readSecret('Repita a senha: ');
    if (first !== second) {
      deps.err('as senhas não conferem');
      return undefined;
    }
  }
  const parsed = newPasswordSchema.safeParse(first);
  if (!parsed.success) {
    deps.err('senha fora da política (12 a 128 caracteres, sem o caractere NUL)');
    return undefined;
  }
  return parsed.data;
}

/** Roda o comando e devolve o código de saída (0 = ok). Nunca lança por entrada do usuário. */
export async function runAuthCli(argv: readonly string[], deps: AuthCliDeps): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || !(COMMANDS as readonly string[]).includes(command)) {
    deps.err(AUTH_CLI_USAGE);
    return 2;
  }

  let values: { email?: string; client?: string; role?: string; 'platform-admin'?: boolean };
  try {
    // `strict`: qualquer opção fora da lista (inclusive `--password`) é recusada. A mensagem do
    // `parseArgs` não é repetida: poderia ecoar o que foi digitado.
    ({ values } = parseArgs({
      args: [...rest],
      options: OPTIONS,
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    if (error instanceof Error) {
      deps.err(`argumento inválido (a senha nunca vem por argumento)\n${AUTH_CLI_USAGE}`);
      return 2;
    }
    throw error;
  }

  const email = emailSchema.safeParse(values.email);
  if (!email.success) return fail(deps, 'informe um --email válido');

  try {
    switch (command) {
      case 'create-platform-admin':
        return await createPlatformAdmin(deps, email.data, values);
      case 'create-user':
        return await createUser(deps, email.data, values);
      default:
        return await resetPassword(deps, email.data, values);
    }
  } catch (error) {
    if (error instanceof CliUsageError) return fail(deps, error.message);
    if (error instanceof ConflictError) return fail(deps, 'já existe uma conta com este e-mail');
    if (error instanceof NotFoundError) return fail(deps, 'cliente ou conta não encontrada');
    throw error;
  }
}

async function createPlatformAdmin(
  deps: AuthCliDeps,
  email: string,
  values: { client?: string; role?: string; 'platform-admin'?: boolean },
): Promise<number> {
  if (
    values.client !== undefined ||
    values.role !== undefined ||
    values['platform-admin'] === true
  ) {
    throw new CliUsageError('create-platform-admin aceita só --email');
  }
  const password = await readNewPassword(deps);
  if (password === undefined) return 1;
  const admin = await deps.platformAdmins.create({
    email,
    passwordHash: await deps.hasher.hash(password),
  });
  deps.out(`criado: ${admin.id}`);
  return 0;
}

async function createUser(
  deps: AuthCliDeps,
  email: string,
  values: { client?: string; role?: string; 'platform-admin'?: boolean },
): Promise<number> {
  if (values['platform-admin'] === true)
    throw new CliUsageError('create-user não aceita --platform-admin');
  const slug = clientSlugSchema.safeParse(values.client);
  if (!slug.success) throw new CliUsageError('informe --client <slug> válido');
  const role = roleSchema.safeParse(values.role);
  if (!role.success) throw new CliUsageError('informe --role OWNER, ADMIN, AGENT ou VIEWER');
  const client = await deps.clients.findBySlug(slug.data);
  const password = await readNewPassword(deps);
  if (password === undefined) return 1;
  const user = await deps.users.create(client.id, {
    email,
    passwordHash: await deps.hasher.hash(password),
    role: role.data,
  });
  deps.out(`criado: ${user.id}`);
  return 0;
}

async function resetPassword(
  deps: AuthCliDeps,
  email: string,
  values: { client?: string; role?: string; 'platform-admin'?: boolean },
): Promise<number> {
  if (values.role !== undefined) throw new CliUsageError('reset-password não aceita --role');
  const platform = values['platform-admin'] === true;
  if (platform === (values.client !== undefined)) {
    throw new CliUsageError('informe --platform-admin ou --client <slug> (um dos dois)');
  }
  if (platform) {
    const found = await deps.platformAdmins.findCredentialsByEmail(email);
    if (found === null) throw new NotFoundError('conta não encontrada');
    const password = await readNewPassword(deps);
    if (password === undefined) return 1;
    await deps.platformAdmins.updatePassword(found.admin.id, await deps.hasher.hash(password));
    await deps.sessions.revokeAllSessions(PLATFORM_SCOPE, found.admin.id);
    deps.out(`senha alterada: ${found.admin.id}`);
    return 0;
  }
  const slug = clientSlugSchema.safeParse(values.client);
  if (!slug.success) throw new CliUsageError('informe --client <slug> válido');
  const client = await deps.clients.findBySlug(slug.data);
  const found = await deps.users.findCredentialsByEmail(client.id, email);
  if (found === null) throw new NotFoundError('conta não encontrada');
  const password = await readNewPassword(deps);
  if (password === undefined) return 1;
  await deps.users.updatePassword(client.id, found.user.id, await deps.hasher.hash(password));
  await deps.sessions.revokeAllSessions(client.id, found.user.id);
  deps.out(`senha alterada: ${found.user.id}`);
  return 0;
}
