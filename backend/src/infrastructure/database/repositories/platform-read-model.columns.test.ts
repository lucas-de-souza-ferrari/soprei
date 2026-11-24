import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// Spec 044, E2 (D6): a leitura que cruza empresas fica num módulo único, com SQL que nunca cita coluna de
// conteúdo. Teste estático (lê o texto do arquivo), sem banco.

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(HERE, '..', '..', '..');
const MODULE = join(HERE, 'platform-read-model.ts');

/** Colunas de conteúdo (texto de mensagem, contato, persona, documento, produto, serviço, segredos, pagamento). */
const FORBIDDEN_COLUMNS = [
  'content',
  'contact_ref',
  'external_id',
  'channel_message_id',
  'persona',
  'title',
  'preview',
  'search_text',
  'sku',
  'description',
  'customer_label',
  'token_ciphertext',
  'registration_pin_ciphertext',
  'checkout_url',
  'provider_transaction_ref',
  'provider_slug',
  'breakdown',
  'password_hash',
  'verification_hash',
  'reset_hash',
  'totp_secret_ciphertext',
];

/**
 * O predicado permitido no SQL extraído: a interpolação do parâmetro vira espaço, e o predicado termina a
 * linha (o próximo é outro `AND`). Nada de literal nem de outra coluna do lado direito.
 */
const ALLOWED_CONTACT_REF = /\bc\.contact_ref <> +\n/g;

/**
 * O texto de todos os templates literais do arquivo (o SQL), sem as interpolações `${...}` (código
 * TypeScript) e sem comentários. Percorre o texto com uma pilha: template -> interpolação -> template...
 */
export function templateText(source: string): string {
  let out = '';
  type Mode = { kind: 'code'; depth: number } | { kind: 'template' };
  const stack: Mode[] = [{ kind: 'code', depth: 0 }];
  let i = 0;
  while (i < source.length) {
    const mode = stack.at(-1);
    const char = source[i] ?? '';
    const next = source[i + 1] ?? '';
    if (mode === undefined) break;
    if (mode.kind === 'template') {
      if (char === '\\') {
        out += source.slice(i, i + 2);
        i += 2;
      } else if (char === '`') {
        stack.pop();
        out += '\n';
        i += 1;
      } else if (char === '$' && next === '{') {
        stack.push({ kind: 'code', depth: 0 });
        out += ' ';
        i += 2;
      } else {
        out += char;
        i += 1;
      }
      continue;
    }
    // Código TypeScript.
    if (char === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) break;
    } else if (char === '/' && next === '*') {
      i = source.indexOf('*/', i) + 2;
    } else if (char === "'" || char === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== char) j += source[j] === '\\' ? 2 : 1;
      i = j + 1;
    } else if (char === '`') {
      stack.push({ kind: 'template' });
      i += 1;
    } else if (char === '{') {
      mode.depth += 1;
      i += 1;
    } else if (char === '}') {
      if (mode.depth === 0 && stack.length > 1) stack.pop();
      else mode.depth -= 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'generated') out.push(...sourceFiles(path));
    } else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

describe('platform-read-model.ts: SQL sem conteúdo (spec 044, E2)', () => {
  const sql = templateText(readFileSync(MODULE, 'utf8')).toLowerCase();

  it('o extrator pega o SQL dos templates e deixa de fora interpolações e comentários', () => {
    const sample = templateText(
      "// content\nconst a = db.$queryRaw`SELECT x ${cond ? Prisma.sql`AND y = ${v}` : Prisma.empty} FROM t`; const persona = 'content';",
    );
    assert.match(sample, /select x/i);
    assert.match(sample, /and y =/i);
    assert.doesNotMatch(sample, /content|persona|cond|prisma/i);
  });

  it('há SQL a conferir (o extrator achou as consultas)', () => {
    for (const table of ['companies', 'messages', 'conversations', 'accounts', 'payment_orders']) {
      assert.match(sql, new RegExp(`\\b${table}\\b`), table);
    }
  });

  it('nenhuma coluna de conteúdo aparece no SQL', () => {
    // A única exceção (revisão da E2, I2): `c.contact_ref <> ${SITE_TEST_CONTACT_REF}`, que tira o
    // "Testar" do site de "precisa de atenção". Compara com um parâmetro; nunca lê nem devolve a coluna.
    const withoutSiteTest = sql.replace(ALLOWED_CONTACT_REF, '');
    for (const column of FORBIDDEN_COLUMNS) {
      assert.doesNotMatch(withoutSiteTest, new RegExp(`\\b${column}\\b`), column);
    }
  });

  it('contact_ref só no predicado do "Testar", sempre contra a constante SITE_TEST_CONTACT_REF', () => {
    const source = readFileSync(MODULE, 'utf8');
    const allowed = sql.match(ALLOWED_CONTACT_REF) ?? [];
    assert.ok(allowed.length > 0, 'o predicado existe');
    assert.equal(
      (sql.match(/\bcontact_ref\b/g) ?? []).length,
      allowed.length,
      'nenhum outro uso de contact_ref',
    );
    assert.equal(
      source.split('c.contact_ref <> ${SITE_TEST_CONTACT_REF}\n').length - 1,
      allowed.length,
      'o valor comparado é sempre o parâmetro SITE_TEST_CONTACT_REF',
    );
    assert.ok(
      source.includes(
        "import { SITE_TEST_CONTACT_REF } from '../../../application/attendance/contact-label.js';",
      ),
    );
  });

  it('"name" só como nome da EMPRESA (co.name), nunca de produto, serviço ou plano', () => {
    const qualified = [...sql.matchAll(/(\w+)\.name\b/g)].map((match) => match[1]);
    assert.ok(qualified.length > 0);
    assert.deepEqual([...new Set(qualified)], ['co']);
    const bare = sql.replace(/\w+\.name\b/g, '').replace(/\bas name\b/g, '');
    assert.doesNotMatch(bare, /\bname\b/);
  });

  it('o e-mail da conta sai completo só no detalhe; a lista só o mascara no banco', () => {
    assert.match(
      sql,
      /substr\(a\.email, 1, 1\) \|\| '\*\*\*@' \|\| split_part\(a\.email, '@', 2\) as email_masked/,
    );
    const plain = sql.match(/\ba\.email\b(?!,\s*'@'|,\s*1,\s*1)/g) ?? [];
    assert.equal(plain.length, 1, 'um único a.email lido por inteiro (accountDetail)');
  });

  it('é o único arquivo novo com SQL cru: a lista de módulos com $queryRaw/$executeRaw não cresce sem revisão', () => {
    const withRaw = sourceFiles(SRC)
      .filter((path) => /\$(queryRaw|executeRaw)/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path).split(sep).join('/'))
      .sort();
    assert.deepEqual(withRaw, [
      'infrastructure/database/database.ts',
      'infrastructure/database/repositories/account.repository.ts',
      'infrastructure/database/repositories/channel-unit-of-work.ts',
      'infrastructure/database/repositories/checkout.repository.ts',
      'infrastructure/database/repositories/contact-schedule-unit-of-work.ts',
      'infrastructure/database/repositories/invitation-expiry.repository.ts',
      'infrastructure/database/repositories/invitation-unit-of-work.ts',
      'infrastructure/database/repositories/knowledge-retriever.ts',
      'infrastructure/database/repositories/membership-admin-unit-of-work.ts',
      'infrastructure/database/repositories/platform-read-model.ts',
      'infrastructure/database/repositories/schedule.repository.ts',
      'infrastructure/database/repositories/unverified-account-purge.repository.ts',
    ]);
  });
});
