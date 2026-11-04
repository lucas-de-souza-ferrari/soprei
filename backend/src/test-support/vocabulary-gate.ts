/**
 * Gate de restos do vocabulário (spec 022): procura os identificadores antigos do domínio
 * (`Client`/`User`, que viraram `Company`/`Membership`) nos arquivos versionados. Função pura (recebe
 * os arquivos), para o teste do próprio gate poder alimentá-la com arquivos sintéticos.
 */

export interface VocabularyFile {
  readonly path: string;
  readonly text: string;
}

/** Exceção por arquivo: o caminho (exato, ou prefixo terminado em `/`) pode conter estes padrões. */
export interface FileException {
  readonly path: string;
  readonly patterns: readonly string[];
  readonly reason: string;
}

/** Pedaço de texto de terceiros (ex.: `pg.Client`) retirado da linha antes de procurar os padrões. */
export interface MaskedToken {
  readonly pattern: string;
  readonly reason: string;
}

export interface VocabularyAllowlist {
  readonly fileExceptions: readonly FileException[];
  readonly maskedTokens: readonly MaskedToken[];
}

export const MARKER_START = '<!-- vocabulario-antigo:inicio -->';
export const MARKER_END = '<!-- vocabulario-antigo:fim -->';

/** Padrões do vocabulário antigo. O nome é o que as exceções citam. */
export const VOCABULARY_PATTERNS: readonly { readonly name: string; readonly regex: RegExp }[] = [
  { name: 'ClientId', regex: /ClientId|clientId|client_id|CLIENT_ID/ },
  {
    name: 'ClientNames',
    regex:
      /ClientRepository|ClientService|ClientStatus|lockClient|ClientSlug|clientSlug|client_status/,
  },
  { name: 'AdminClientsRoute', regex: /\/admin\/clients/ },
  { name: 'SqlTables', regex: /\b(FROM|JOIN|INTO|UPDATE) (clients|users)\b/i },
  { name: 'UserNames', regex: /UserRole|UserStatus|UserId|userId|user_id|user_role|user_status/ },
  { name: 'UserAdmin', regex: /UserAdmin|userAdmin/ },
  {
    name: 'AuditActions',
    regex: /USER_(CREATED|ROLE|DISABLED|ENABLED|PASSWORD)/,
  },
  { name: 'ClientHeader', regex: /x-soprei-client/i },
  { name: 'WordClient', regex: /\b(Client|Clients|clients)\b/ },
  { name: 'WordUser', regex: /\b(User|users)\b/ },
  { name: 'Cliente', regex: /\b[Cc]lientes?\b/ },
];

export interface Violation {
  readonly path: string;
  readonly line: number;
  readonly pattern: string;
}

export interface GateResult {
  readonly violations: readonly Violation[];
  /** Exceções ou máscaras que não casaram com nada (a lista não pode apodrecer). */
  readonly unused: readonly string[];
}

function matchesPath(rule: string, path: string): boolean {
  return rule.endsWith('/') ? path.startsWith(rule) : path === rule;
}

export function findVocabularyLeftovers(
  files: readonly VocabularyFile[],
  allowlist: VocabularyAllowlist,
): GateResult {
  const maskUsage = new Map<string, number>();
  const exceptionUsage = new Map<string, number>();
  const masks = allowlist.maskedTokens.map((entry) => ({
    entry,
    regex: new RegExp(entry.pattern, 'g'),
  }));
  const violations: Violation[] = [];

  for (const file of files) {
    const markdown = file.path.endsWith('.md');
    let inLegacyRegion = false;
    const lines = file.text.split('\n');
    for (const [index, raw] of lines.entries()) {
      if (markdown && raw.includes(MARKER_START)) {
        inLegacyRegion = true;
        continue;
      }
      if (markdown && raw.includes(MARKER_END)) {
        inLegacyRegion = false;
        continue;
      }
      if (inLegacyRegion) continue;
      let line = raw;
      for (const { entry, regex } of masks) {
        line = line.replace(regex, () => {
          maskUsage.set(entry.pattern, (maskUsage.get(entry.pattern) ?? 0) + 1);
          return ' ';
        });
      }
      for (const { name, regex } of VOCABULARY_PATTERNS) {
        if (!regex.test(line)) continue;
        const exception = allowlist.fileExceptions.find(
          (rule) => matchesPath(rule.path, file.path) && rule.patterns.includes(name),
        );
        if (exception !== undefined) {
          const key = `${exception.path}#${name}`;
          exceptionUsage.set(key, (exceptionUsage.get(key) ?? 0) + 1);
          continue;
        }
        violations.push({ path: file.path, line: index + 1, pattern: name });
      }
    }
  }

  const unused: string[] = [];
  for (const entry of allowlist.maskedTokens) {
    if (!maskUsage.has(entry.pattern)) unused.push(`máscara sem uso: ${entry.pattern}`);
  }
  for (const rule of allowlist.fileExceptions) {
    for (const name of rule.patterns) {
      if (!exceptionUsage.has(`${rule.path}#${name}`)) {
        unused.push(`exceção sem uso: ${rule.path} (${name})`);
      }
    }
  }
  return { violations, unused };
}
