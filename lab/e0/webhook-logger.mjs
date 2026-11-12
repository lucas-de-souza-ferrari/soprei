// Registrador de webhook do laboratório E0 (spec 039). Temporário: roda NO LUGAR do Soprei, na mesma
// porta (o nginx já manda /webhooks/ para ela), enquanto o Soprei está parado no PM2. Não grava nem
// imprime conteúdo: só o nome do campo, as chaves, tipos, tamanhos e uma referência curta (hash) dos
// ids, para cruzar com o "node lab.mjs enviar". Confere a assinatura da Meta antes de ler o corpo.
//   node webhook-logger.mjs           (Ctrl+C para parar)
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const ENV_FILE = process.env.SOPREI_ENV_FILE ?? '/var/www/soprei/backend/.env';
const PORT = Number(process.env.LAB_PORT ?? 3001);
const OUT = process.env.LAB_OUT ?? '/root/soprei-lab-webhooks.log';
const MAX_BODY = 3 * 1024 * 1024;

function readEnv(name) {
  const line = readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith(`${name}=`));
  if (line === undefined) return undefined;
  let value = line.slice(name.length + 1).trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

const APP_SECRET = readEnv('WHATSAPP_APP_SECRET');
const VERIFY_TOKEN = readEnv('WHATSAPP_VERIFY_TOKEN');
if (!APP_SECRET) {
  console.log('WHATSAPP_APP_SECRET ausente no .env do backend');
  process.exit(1);
}

const ref = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 10);

function out(line) {
  const text = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
  console.log(text);
  appendFileSync(OUT, `${text}\n`, { mode: 0o600 });
}

// Valores que podem aparecer: só tipos, estados e nomes de evento. Ids viram referência curta.
const SAFE_VALUE_KEYS = new Set([
  'field',
  'type',
  'event',
  'status',
  'messaging_product',
  'object',
]);
const ID_KEYS = new Set(['id', 'message_id', 'wa_id']);

function shape(value, key = '', depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (depth > 6) return `lista(${value.length})`;
    const sample = value.slice(0, 2).map((item) => shape(item, key, depth + 1));
    return `lista(${value.length})[${sample.join(' | ')}]`;
  }
  if (typeof value === 'object') {
    if (depth > 6) return 'objeto';
    const parts = Object.keys(value)
      .sort()
      .map((name) => `${name}:${shape(value[name], name, depth + 1)}`);
    return `{${parts.join(', ')}}`;
  }
  if (ID_KEYS.has(key) && (typeof value === 'string' || typeof value === 'number')) {
    return `ref=${ref(value)}`;
  }
  if (SAFE_VALUE_KEYS.has(key) && typeof value === 'string' && value.length <= 40) {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return `texto(${value.length})`;
  return typeof value;
}

function signatureOk(header, raw) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', APP_SECRET).update(raw).digest('hex'));
  const received = Buffer.from(header.slice('sha256='.length));
  return expected.length === received.length && timingSafeEqual(expected, received);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://local');
  if (!url.pathname.startsWith('/webhooks/whatsapp')) {
    response.writeHead(404).end();
    return;
  }
  if (request.method === 'GET') {
    // Verificação da Meta (só acontece se o endereço for reconfigurado no painel).
    const ok =
      url.searchParams.get('hub.mode') === 'subscribe' &&
      VERIFY_TOKEN !== undefined &&
      url.searchParams.get('hub.verify_token') === VERIFY_TOKEN;
    out(`GET de verificação: ${ok ? 'aceito' : 'recusado'}`);
    response.writeHead(ok ? 200 : 403).end(ok ? (url.searchParams.get('hub.challenge') ?? '') : '');
    return;
  }
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }
  const chunks = [];
  let size = 0;
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) request.destroy();
    else chunks.push(chunk);
  });
  request.on('end', () => {
    const raw = Buffer.concat(chunks);
    if (!signatureOk(request.headers['x-hub-signature-256'], raw)) {
      out('POST com assinatura inválida (ignorado)');
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200).end();
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      out(`POST assinado com corpo que não é JSON (${raw.length} bytes)`);
      return;
    }
    for (const entry of Array.isArray(body.entry) ? body.entry : []) {
      for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
        out(`CAMPO "${change.field}" (${raw.length} bytes): ${shape(change.value, 'value')}`);
      }
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  out(`registrador no ar em 127.0.0.1:${PORT} (Ctrl+C para parar); registro em ${OUT}`);
});
