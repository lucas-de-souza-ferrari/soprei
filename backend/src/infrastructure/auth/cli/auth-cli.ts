import { parseArgs } from 'node:util';
import { z } from 'zod';
import { PLATFORM_SCOPE } from '../../../application/auth/identity.js';
import {
  companySlugSchema,
  emailSchema,
  newPasswordSchema,
} from '../../../application/auth/credentials.js';
import type { PasswordHasher } from '../../../application/ports/password-hasher.js';
import type { PlatformSecretCipher } from '../../../application/ports/platform-secret-cipher.js';
import {
  base32Encode,
  generateTotpSecret,
  matchTotp,
  otpauthUri,
} from '../../../application/platform/totp.js';
import type { SessionStore } from '../../../application/ports/session-store.js';
import {
  type CompanyRepository,
  type PlatformAdminRepository,
  MEMBERSHIP_ROLES,
  type MembershipRepository,
} from '../../../domain/index.js';
import { ConflictError, NotFoundError } from '../../../shared/errors/index.js';
import { SecretString } from '../../../shared/types/index.js';

/**
 * Comando local do dono para criar o primeiro usuário (spec 007). **A senha nunca vem por argumento
 * nem por variável de ambiente**: é pedida no terminal sem eco (digitada duas vezes) ou, sem
 * terminal, lida da primeira linha do `stdin`. Nada além do id é impresso: nem e-mail, nem senha,
 * nem hash. As mensagens de erro são constantes (não ecoam o que foi digitado).
 */
export interface AuthCliDeps {
  readonly companies: CompanyRepository;
  readonly memberships: MembershipRepository;
  readonly platformAdmins: PlatformAdminRepository;
  readonly hasher: PasswordHasher;
  readonly sessions: SessionStore;
  /**
   * Cifra do segredo TOTP (spec 044), montada de `PLATFORM_TOTP_KEYS`; sem ela
   * `enroll-platform-totp` recusa (nada é gravado).
   */
  readonly platformCipher?: PlatformSecretCipher | undefined;
  /** Relógio (milissegundos) do cadastro do fator; injetável nos testes. */
  readonly now?: () => number;
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
  '  pnpm auth:cli create-user --company <slug> --email <e-mail> --role OWNER|ADMIN|AGENT|VIEWER',
  '  pnpm auth:cli reset-password (--platform-admin | --company <slug>) --email <e-mail>',
  '  pnpm auth:cli enroll-platform-totp --email <e-mail>',
  'A senha é pedida no terminal (sem eco); nunca por argumento nem por variável de ambiente.',
].join('\n');

const COMMANDS = [
  'create-platform-admin',
  'create-user',
  'reset-password',
  'enroll-platform-totp',
] as const;

const OPTIONS = {
  email: { type: 'string' },
  company: { type: 'string' },
  role: { type: 'string' },
  'platform-admin': { type: 'boolean' },
} as const;

class CliUsageError extends Error {}

const roleSchema = z.enum(MEMBERSHIP_ROLES);

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

  let values: { email?: string; company?: string; role?: string; 'platform-admin'?: boolean };
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
        return await createMembership(deps, email.data, values);
      case 'enroll-platform-totp':
        return await enrollPlatformTotp(deps, email.data, values);
      default:
        return await resetPassword(deps, email.data, values);
    }
  } catch (error) {
    if (error instanceof CliUsageError) return fail(deps, error.message);
    if (error instanceof ConflictError) return fail(deps, 'já existe uma conta com este e-mail');
    if (error instanceof NotFoundError) return fail(deps, 'empresa ou conta não encontrada');
    throw error;
  }
}

async function createPlatformAdmin(
  deps: AuthCliDeps,
  email: string,
  values: { company?: string; role?: string; 'platform-admin'?: boolean },
): Promise<number> {
  if (
    values.company !== undefined ||
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

async function createMembership(
  deps: AuthCliDeps,
  email: string,
  values: { company?: string; role?: string; 'platform-admin'?: boolean },
): Promise<number> {
  if (values['platform-admin'] === true)
    throw new CliUsageError('create-user não aceita --platform-admin');
  const slug = companySlugSchema.safeParse(values.company);
  if (!slug.success) throw new CliUsageError('informe --company <slug> válido');
  const role = roleSchema.safeParse(values.role);
  if (!role.success) throw new CliUsageError('informe --role OWNER, ADMIN, AGENT ou VIEWER');
  const company = await deps.companies.findBySlug(slug.data);
  const password = await readNewPassword(deps);
  if (password === undefined) return 1;
  const membership = await deps.memberships.create(company.id, {
    email,
    passwordHash: await deps.hasher.hash(password),
    role: role.data,
  });
  deps.out(`criado: ${membership.id}`);
  return 0;
}

async function resetPassword(
  deps: AuthCliDeps,
  email: string,
  values: { company?: string; role?: string; 'platform-admin'?: boolean },
): Promise<number> {
  if (values.role !== undefined) throw new CliUsageError('reset-password não aceita --role');
  const platform = values['platform-admin'] === true;
  if (platform === (values.company !== undefined)) {
    throw new CliUsageError('informe --platform-admin ou --company <slug> (um dos dois)');
  }
  if (platform) {
    const found = await deps.platformAdmins.findCredentialsByEmail(email);
    if (found === null) throw new NotFoundError('conta não encontrada');
    const password = await readNewPassword(deps);
    if (password === undefined) return 1;
    await deps.platformAdmins.updatePassword(found.admin.id, await deps.hasher.hash(password));
    // Spec 044: a redefinição apaga também o segundo fator (perdeu o celular? refaz os dois). Sem fator,
    // as sessões do cookie do admin caem na próxima requisição.
    await deps.platformAdmins.setTotpSecret(found.admin.id, null);
    await deps.sessions.revokeAllSessions(PLATFORM_SCOPE, found.admin.id);
    deps.out(`senha alterada: ${found.admin.id}`);
    deps.out('segundo fator apagado: cadastre de novo com enroll-platform-totp');
    return 0;
  }
  const slug = companySlugSchema.safeParse(values.company);
  if (!slug.success) throw new CliUsageError('informe --company <slug> válido');
  const company = await deps.companies.findBySlug(slug.data);
  const found = await deps.memberships.findCredentialsByEmail(company.id, email);
  if (found === null) throw new NotFoundError('conta não encontrada');
  const password = await readNewPassword(deps);
  if (password === undefined) return 1;
  await deps.memberships.updatePassword(
    company.id,
    found.membership.id,
    await deps.hasher.hash(password),
  );
  await deps.sessions.revokeAllSessions(company.id, found.membership.id);
  deps.out(`senha alterada: ${found.membership.id}`);
  return 0;
}

/**
 * Cadastra (ou troca) o segundo fator do administrador da plataforma (spec 044, E1). Imprime **uma vez** a
 * URI `otpauth://` e a chave para digitar no aplicativo autenticador, pede um código e só grava se ele
 * conferir; o passo desse código fica marcado como usado. As sessões do admin abertas com o fator antigo
 * caem na próxima requisição.
 */
async function enrollPlatformTotp(
  deps: AuthCliDeps,
  email: string,
  values: { company?: string; role?: string; 'platform-admin'?: boolean },
): Promise<number> {
  if (
    values.company !== undefined ||
    values.role !== undefined ||
    values['platform-admin'] === true
  ) {
    throw new CliUsageError('enroll-platform-totp aceita só --email');
  }
  if (deps.platformCipher === undefined) {
    throw new CliUsageError(
      'defina PLATFORM_TOTP_KEYS e PLATFORM_TOTP_ACTIVE_KEY_ID no .env antes de cadastrar o fator',
    );
  }
  const found = await deps.platformAdmins.findCredentialsByEmail(email);
  if (found === null) throw new NotFoundError('conta não encontrada');
  const secret = generateTotpSecret();
  const encoded = base32Encode(secret);
  deps.out('Leve ao aplicativo autenticador (só aparece agora):');
  deps.out(otpauthUri(encoded));
  deps.out(`chave para digitar: ${encoded}`);
  const code = (await deps.readSecret('Código de 6 dígitos do aplicativo: ')).trim();
  const step = matchTotp(secret, code, (deps.now ?? Date.now)());
  if (step === undefined) {
    deps.err(
      'o código não confere; nada foi gravado (confira o relógio do celular e tente de novo)',
    );
    return 1;
  }
  const ciphertext = deps.platformCipher.encrypt(found.admin.id, new SecretString(encoded));
  await deps.platformAdmins.setTotpSecret(found.admin.id, ciphertext);
  // O código usado no cadastro não serve para entrar.
  await deps.platformAdmins.claimTotpStep(found.admin.id, step);
  deps.out(`segundo fator cadastrado: ${found.admin.id}`);
  return 0;
}
