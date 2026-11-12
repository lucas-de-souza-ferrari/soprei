// Laboratório E0 da spec 039 (coexistência). Temporário: não faz parte do Soprei e sai do servidor
// no fim do teste. Rodar como root no servidor:
//   node lab.mjs conectar   -> troca o code pelo token, mostra a conta e o número, assina o app na WABA
//   node lab.mjs enviar     -> manda uma mensagem de teste pela Cloud API (para ver se ela gera eco)
//   node lab.mjs limpar     -> desassina o app da WABA e apaga o estado guardado (token incluído)
// Nada de telefone, token, code ou id completo é impresso: telefone só com os 4 últimos dígitos e ids
// como referência curta (hash), para cruzar com o que o registrador de webhook mostra.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

const ENV_FILE = process.env.SOPREI_ENV_FILE ?? '/var/www/soprei/backend/.env';
// Pasta só do estado (token, WABA e número), separada da pasta com os arquivos do laboratório.
const LAB_DIR = '/root/soprei-lab-state';
const STATE_FILE = `${LAB_DIR}/state.json`;

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

const APP_ID = readEnv('WHATSAPP_APP_ID');
const APP_SECRET = readEnv('WHATSAPP_APP_SECRET');
const VERSION = readEnv('WHATSAPP_GRAPH_API_VERSION') ?? 'v26.0';
const GRAPH = `https://graph.facebook.com/${VERSION}`;

if (!APP_ID || !APP_SECRET) {
  console.log('WHATSAPP_APP_ID ou WHATSAPP_APP_SECRET ausente no .env do backend');
  process.exit(1);
}

const ref = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 10);
const last4 = (phone) =>
  phone ? `final ${String(phone).replace(/\D/g, '').slice(-4)}` : '(sem número)';

function errorInfo(json) {
  const error = json && json.error;
  if (!error) return '';
  const sub = error.error_subcode ? `/${error.error_subcode}` : '';
  return `erro ${error.code ?? '?'}${sub} (${error.type ?? 'sem tipo'})`;
}

async function graph(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch(`${GRAPH}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  let json = {};
  try {
    json = await response.json();
  } catch {
    json = {};
  }
  return { status: response.status, json };
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function saveState(state) {
  mkdirSync(LAB_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
}

function loadState() {
  if (!existsSync(STATE_FILE)) {
    console.log('sem estado: rode "node lab.mjs conectar" primeiro');
    process.exit(1);
  }
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

async function conectar() {
  const code = await ask('Cole o code e aperte Enter: ');
  if (!code) {
    console.log('code vazio');
    process.exit(1);
  }
  const params = new URLSearchParams({ client_id: APP_ID, client_secret: APP_SECRET, code });
  const exchange = await graph(`/oauth/access_token?${params}`);
  const token = exchange.json.access_token;
  if (!token) {
    console.log(`1. troca do code FALHOU: HTTP ${exchange.status} ${errorInfo(exchange.json)}`);
    console.log('   (o code vale ~30 s e só uma vez: abra o popup de novo e cole mais rápido)');
    process.exit(1);
  }
  console.log(
    `1. troca do code: ok (expira em: ${exchange.json.expires_in ?? 'sem prazo informado'})`,
  );

  const appToken = `${APP_ID}|${APP_SECRET}`;
  const debug = await graph(`/debug_token?${new URLSearchParams({ input_token: token })}`, {
    token: appToken,
  });
  const data = debug.json.data ?? {};
  console.log(
    `2. debug_token: válido=${data.is_valid} app_confere=${data.app_id === APP_ID} tipo=${data.type ?? '?'}`,
  );
  console.log(`   escopos: ${(data.scopes ?? []).join(', ') || '(nenhum)'}`);
  const granular = data.granular_scopes ?? [];
  for (const scope of granular) {
    console.log(`   ${scope.scope}: ${(scope.target_ids ?? []).length} alvo(s)`);
  }
  const wabas = [
    ...new Set(
      granular
        .filter((scope) => scope.scope === 'whatsapp_business_management')
        .flatMap((scope) => scope.target_ids ?? []),
    ),
  ];
  console.log(`   contas do WhatsApp (WABA) no token: ${wabas.map(ref).join(', ') || '(nenhuma)'}`);
  if (wabas.length === 0) {
    console.log('   sem WABA no token: anote isso e pare aqui');
    process.exit(1);
  }

  const basic =
    'id,display_phone_number,verified_name,status,platform_type,code_verification_status,quality_rating';
  let phoneId = '';
  let wabaId = '';
  for (const waba of wabas) {
    const list = await graph(`/${waba}/phone_numbers?fields=${basic}`, { token });
    if (list.status !== 200) {
      console.log(
        `3. números da WABA ${ref(waba)}: FALHOU HTTP ${list.status} ${errorInfo(list.json)}`,
      );
      continue;
    }
    const numbers = list.json.data ?? [];
    console.log(`3. números da WABA ${ref(waba)}: ${numbers.length}`);
    for (const number of numbers) {
      console.log(
        `   número ${last4(number.display_phone_number)} id=${ref(number.id)} status=${number.status ?? '?'} ` +
          `plataforma=${number.platform_type ?? '?'} verificação=${number.code_verification_status ?? '?'} ` +
          `qualidade=${number.quality_rating ?? '?'} nome_verificado=${number.verified_name ? 'sim' : 'não'}`,
      );
      if (!phoneId) {
        phoneId = number.id;
        wabaId = waba;
      }
      // Campo da coexistência (nome não confirmado): se não existir, a Meta devolve erro e anotamos.
      const probe = await graph(`/${number.id}?fields=is_on_biz_app`, { token });
      console.log(
        probe.status === 200
          ? `   is_on_biz_app=${probe.json.is_on_biz_app}`
          : `   is_on_biz_app: indisponível (HTTP ${probe.status} ${errorInfo(probe.json)})`,
      );
    }
  }
  if (!phoneId) {
    console.log('   nenhum número encontrado: anote isso e pare aqui');
    process.exit(1);
  }

  const subscribe = await graph(`/${wabaId}/subscribed_apps`, { method: 'POST', token });
  console.log(
    `4. assinar o app na WABA (para os webhooks chegarem): HTTP ${subscribe.status} ` +
      `${subscribe.json.success === true ? 'ok' : errorInfo(subscribe.json)}`,
  );
  saveState({ token, wabaId, phoneId });
  console.log(`5. estado guardado em ${STATE_FILE} (só root lê; "node lab.mjs limpar" apaga)`);
  console.log('   NÃO chamamos /register: o número continua sendo do aplicativo.');
}

async function enviar() {
  const { token, phoneId } = loadState();
  const to = (await ask('Número de destino (só dígitos, com 55 e DDD): ')).replace(/\D/g, '');
  if (to.length < 10) {
    console.log('número inválido');
    process.exit(1);
  }
  const sent = await graph(`/${phoneId}/messages`, {
    method: 'POST',
    token,
    body: {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: 'Teste do laboratório Soprei (E0), pode ignorar.' },
    },
  });
  const id = sent.json.messages && sent.json.messages[0] && sent.json.messages[0].id;
  console.log(
    id
      ? `envio pela Cloud API: ok, id da mensagem ref=${ref(id)} (procure essa ref no registrador)`
      : `envio pela Cloud API: FALHOU HTTP ${sent.status} ${errorInfo(sent.json)} ` +
          '(o contato precisa ter escrito para este número nas últimas 24 h)',
  );
}

async function limpar() {
  if (existsSync(STATE_FILE)) {
    const { token, wabaId } = loadState();
    const unsubscribe = await graph(`/${wabaId}/subscribed_apps`, { method: 'DELETE', token });
    console.log(
      `desassinar o app da WABA: HTTP ${unsubscribe.status} ` +
        `${unsubscribe.json.success === true ? 'ok' : errorInfo(unsubscribe.json)}`,
    );
  }
  rmSync(LAB_DIR, { recursive: true, force: true });
  console.log(`${LAB_DIR} apagado (estado e token).`);
}

const command = process.argv[2];
if (command === 'conectar') await conectar();
else if (command === 'enviar') await enviar();
else if (command === 'limpar') await limpar();
else {
  console.log('uso: node lab.mjs conectar | enviar | limpar');
  process.exit(1);
}
