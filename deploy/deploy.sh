#!/usr/bin/env bash
# Soprei, spec 037: deploy com rollback. Uso e códigos de saída em docs/ops/deploy.md.
#
#   deploy/deploy.sh --env <production|staging> [--ref <branch|tag|sha>] [--previous]
#                    [--dry-run] [--force] [--adopt] [--allow-breaking]
#                    [--allow-unstaged] [--inject-health-failure] [--auto]
#
# --auto (E3, deploy automático pelo programa de entrada): só com --ref de 40 hexadecimais minúsculos,
# nunca junto de --previous, --force, --adopt, --allow-breaking ou --inject-health-failure; depois do
# git fetch, o SHA precisa estar na main e não pode ser mais antigo que a versão registrada.
#
# Códigos de saída: 0 concluído; 1 recusado antes de mexer (nada mudou); 2 falhou e a versão anterior
# voltou saudável; 3 falhou e o rollback também falhou (intervenção manual).
#
# Regras do script (a spec 037 e o teste deploy-scripts.test.ts as impõem):
#   - toda a lógica fica em funções e a última linha chama `main`: o bash lê o arquivo inteiro antes de
#     executar, porque o deploy troca o Git no meio da execução;
#   - o `.env` nunca é lido por `source`: os valores saem por grep e cut e nunca são impressos;
#   - toda saída passa por um filtro de redação (rede de segurança) e o script nunca liga o modo de
#     rastreamento do shell.
set -Eeuo pipefail
umask 077
export LC_ALL=C
IFS=$' \t\n'
export GIT_TERMINAL_PROMPT=0

# Ganchos de teste (o padrão é o caminho de produção); definidos só por quem já controla o ambiente.
LOCK_FILE=${SOPREI_DEPLOY_LOCK_FILE:-/var/lock/soprei-deploy.lock}
STATE_ROOT=${SOPREI_DEPLOY_STATE_DIR:-/var/lib/soprei-deploy}
LOG_ROOT=${SOPREI_DEPLOY_LOG_DIR:-/var/log/soprei-deploy}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TARGETS_DIR=${SOPREI_DEPLOY_TARGETS_DIR:-$SCRIPT_DIR/targets}

# Argumentos.
ENV_NAME=''
REF=main
USE_PREVIOUS=false
DRY_RUN=false
FORCE=false
ADOPT=false
ALLOW_BREAKING=false
ALLOW_UNSTAGED=false
INJECT_HEALTH_FAILURE=false
AUTO=false

# Alvo (deploy/targets/<ambiente>.conf).
APP_DIR=''
ENV_FILE=''
PM2_APP=''
PORT=''
HEALTH_URL=''
READY_URL=''
SITE_HOST=''
SITE_OK_CODES=200
ADMIN_HOST=''
ADMIN_OK_CODES=200
REQUIRE_STAGED=false
PRE_MIGRATION_BACKUP=''
HEALTH_TIMEOUT_SECONDS=90
HEALTH_INTERVAL_SECONDS=2
HEALTH_STABLE_COUNT=5
MIGRATE_TIMEOUT_SECONDS=300
MIN_FREE_KB=2097152
BUILD_MEMORY_MB=1024

# Estado da execução.
LOG_FILE=''
RUN_USER=''
STATE_DIR=''
CURRENT_SHA=''
PREVIOUS_SHA=''
HEAD_SHA=''
PREV_SHA=''
TARGET_SHA=''
ADOPT_PENDING=false
TREE_CHANGED=false
POINT_OF_NO_RETURN=false
NEW_RELEASE=''
# Apps estáticos publicados por release com atalho (spec 044, E4): o site sempre e o admin quando a
# versão pedida tem a pasta admin/. O estado de cada um fica em SWITCHED_<app>, LEGACY_MOVED_<app> e
# PREV_RELEASE_<app>, iniciados por build_frontend e lidos por indireção.
STATIC_APPS=()
PM2_STATUS=''
PM2_RESTARTS=0
NOW_MS=0
RELOAD_START_MS=0
FIRST_GOOD_MS=0
ENV_VALUE=''
SHA_VALUE=''
MIGRATION_NAMES=()
BREAKING_NAMES=()
UNAPPROVED_NAMES=()
BREAKING_KEYWORDS=''

# ---------------------------------------------------------------------------------------------
# Saída, log e redação
# ---------------------------------------------------------------------------------------------

# Rede de segurança: o script não imprime segredo por desenho; se algum comando filho imprimir,
# a URL de conexão e os valores de variáveis de nome sensível saem como [redacted].
redact() {
  sed -u -E \
    -e 's#(postgres(ql)?|rediss?|amqp|mongodb)://[^[:space:]"'"'"']+#[redacted]#g' \
    -e 's#//[^/[:space:]]*:[^@[:space:]]*@#//[redacted]@#g' \
    -e 's#(JWT_SECRET|[A-Za-z0-9_]*(KEY|SECRET|TOKEN|PSWD|PASSWORD)S?)=[^[:space:]]+#\1=[redacted]#gI'
}

log() {
  printf '%s [%s] %s (usuario=%s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ENV_NAME" "$*" "$RUN_USER"
}

die_early() {
  printf 'deploy.sh: %s\n' "$*" >&2
  exit 1
}

die1() {
  log "RECUSADO: $*"
  exit 1
}

# Roda um comando sem o descritor da trava (9): um filho de longa vida (como o daemon do PM2) não
# pode herdar a trava e segurá-la depois do fim do deploy.
run_cmd() {
  "$@" 9>&-
}

short() {
  printf '%s' "${1:0:7}"
}

now_ms() {
  NOW_MS=$((${EPOCHREALTIME/./} / 1000))
}

usage() {
  printf '%s\n' \
    'uso: deploy/deploy.sh --env <production|staging> [--ref <branch|tag|sha>] [--previous]' \
    '                      [--dry-run] [--force] [--adopt] [--allow-breaking]' \
    '                      [--allow-unstaged] [--inject-health-failure] [--auto]' \
    '' \
    '--env é obrigatório (não existe padrão). Detalhes em docs/ops/deploy.md.'
}

# ---------------------------------------------------------------------------------------------
# Argumentos e alvo
# ---------------------------------------------------------------------------------------------

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --env)
        (($# >= 2)) || die_early '--env precisa de um valor'
        ENV_NAME=$2
        shift 2
        ;;
      --ref)
        (($# >= 2)) || die_early '--ref precisa de um valor'
        REF=$2
        shift 2
        ;;
      --previous) USE_PREVIOUS=true; shift ;;
      --dry-run) DRY_RUN=true; shift ;;
      --force) FORCE=true; shift ;;
      --adopt) ADOPT=true; shift ;;
      --allow-breaking) ALLOW_BREAKING=true; shift ;;
      --allow-unstaged) ALLOW_UNSTAGED=true; shift ;;
      --inject-health-failure) INJECT_HEALTH_FAILURE=true; shift ;;
      --auto) AUTO=true; shift ;;
      -h | --help) usage; exit 0 ;;
      *) usage >&2; die_early "argumento desconhecido: $1" ;;
    esac
  done

  [[ -n $ENV_NAME ]] || { usage >&2; die_early '--env é obrigatório (production ou staging)'; }
  case "$ENV_NAME" in
    production | staging) ;;
    *) die_early "--env inválido: use production ou staging" ;;
  esac
  [[ $REF =~ ^[A-Za-z0-9._/-]{1,100}$ && $REF != -* ]] || die_early '--ref inválido'
  if [[ $INJECT_HEALTH_FAILURE == true && $ENV_NAME != staging ]]; then
    die_early '--inject-health-failure só é aceito com --env staging'
  fi
  if [[ $ALLOW_UNSTAGED == true && $ENV_NAME != production ]]; then
    die_early '--allow-unstaged só vale com --env production'
  fi
  if [[ $AUTO == true ]]; then
    # O automático só pede "este SHA, para a frente": nada de branch, tag, SHA curto nem opção que
    # volta, reimplanta, adota, libera migration destrutiva ou injeta falha.
    [[ $REF =~ ^[0-9a-f]{40}$ ]] || die_early '--auto exige --ref com o SHA completo (40 hexadecimais minúsculos)'
    if [[ $USE_PREVIOUS == true || $FORCE == true || $ADOPT == true || $ALLOW_BREAKING == true || $INJECT_HEALTH_FAILURE == true ]]; then
      die_early '--auto não aceita --previous, --force, --adopt, --allow-breaking nem --inject-health-failure'
    fi
  fi
}

# Lê deploy/targets/<ambiente>.conf como texto (nunca por source). Só chaves conhecidas, e valores
# sem espaço, aspas, crase nem cifrão.
load_target() {
  local file="$TARGETS_DIR/$ENV_NAME.conf" line key value
  [[ -r $file ]] || die_early "arquivo de alvo ilegível: $file"
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    case "$line" in '' | '#'*) continue ;; esac
    [[ $line == *=* ]] || die_early "linha inválida no alvo: $line"
    key=${line%%=*}
    value=${line#*=}
    [[ $value =~ ^[A-Za-z0-9_./:@%+,-]*$ ]] || die_early "valor inválido para $key no alvo"
    case "$key" in
      APP_DIR) APP_DIR=$value ;;
      ENV_FILE) ENV_FILE=$value ;;
      PM2_APP) PM2_APP=$value ;;
      PORT) PORT=$value ;;
      HEALTH_URL) HEALTH_URL=$value ;;
      READY_URL) READY_URL=$value ;;
      SITE_HOST) SITE_HOST=$value ;;
      SITE_OK_CODES) SITE_OK_CODES=$value ;;
      ADMIN_HOST) ADMIN_HOST=$value ;;
      ADMIN_OK_CODES) ADMIN_OK_CODES=$value ;;
      REQUIRE_STAGED) REQUIRE_STAGED=$value ;;
      PRE_MIGRATION_BACKUP) PRE_MIGRATION_BACKUP=$value ;;
      HEALTH_TIMEOUT_SECONDS) HEALTH_TIMEOUT_SECONDS=$value ;;
      HEALTH_INTERVAL_SECONDS) HEALTH_INTERVAL_SECONDS=$value ;;
      HEALTH_STABLE_COUNT) HEALTH_STABLE_COUNT=$value ;;
      MIGRATE_TIMEOUT_SECONDS) MIGRATE_TIMEOUT_SECONDS=$value ;;
      MIN_FREE_KB) MIN_FREE_KB=$value ;;
      BUILD_MEMORY_MB) BUILD_MEMORY_MB=$value ;;
      *) die_early "chave desconhecida no alvo: $key" ;;
    esac
  done <"$file"

  local required
  for required in APP_DIR ENV_FILE PM2_APP PORT HEALTH_URL READY_URL SITE_HOST; do
    [[ -n ${!required} ]] || die_early "alvo sem $required"
  done
  [[ $APP_DIR == /* ]] || die_early 'APP_DIR precisa ser caminho absoluto'
  # Endurecimento do alvo: nada de "..", de componente começando com "-", nem de APP_DIR raso (nunca "/").
  local path_key
  for path_key in APP_DIR ENV_FILE PRE_MIGRATION_BACKUP; do
    [[ ${!path_key} != *..* && ${!path_key} != */-* ]] || die_early "$path_key com '..' ou componente começando com '-'"
  done
  [[ $APP_DIR =~ ^/[^/]+/[^/]+ ]] || die_early 'APP_DIR raso demais (precisa de pelo menos dois níveis)'
  [[ $PM2_APP != -* && $SITE_HOST != -* && $ADMIN_HOST != -* ]] \
    || die_early 'PM2_APP, SITE_HOST e ADMIN_HOST não podem começar com "-"'
  [[ $ADMIN_HOST != "$SITE_HOST" ]] || die_early 'ADMIN_HOST precisa ser diferente de SITE_HOST (spec 044, D3)'
  [[ $HEALTH_URL == http://127.0.0.1:* && $READY_URL == http://127.0.0.1:* ]] \
    || die_early 'HEALTH_URL e READY_URL precisam começar com http://127.0.0.1:'
  [[ $ENV_FILE == "$APP_DIR/backend/.env" ]] \
    || die_early 'o arquivo de ambiente do alvo precisa ser APP_DIR/backend/.env (o dotenv lê o do diretório atual)'
  [[ $REQUIRE_STAGED == true || $REQUIRE_STAGED == false ]] || die_early 'REQUIRE_STAGED inválido'
  local numeric
  for numeric in HEALTH_TIMEOUT_SECONDS HEALTH_STABLE_COUNT MIGRATE_TIMEOUT_SECONDS MIN_FREE_KB BUILD_MEMORY_MB; do
    [[ ${!numeric} =~ ^[0-9]+$ ]] || die_early "$numeric inválido no alvo"
  done
  [[ $HEALTH_INTERVAL_SECONDS =~ ^[0-9]+(\.[0-9]+)?$ ]] || die_early 'HEALTH_INTERVAL_SECONDS inválido no alvo'
  STATE_DIR="$STATE_ROOT/$ENV_NAME"
}

open_log() {
  [[ -d $LOG_ROOT ]] || die_early "diretório de log inexistente: $LOG_ROOT (o dono o cria; ver docs/ops/deploy.md)"
  LOG_FILE="$LOG_ROOT/$ENV_NAME.log"
  : >>"$LOG_FILE" || die_early "não consegui abrir o log: $LOG_FILE"
  chmod 600 "$LOG_FILE" || true
}

# ---------------------------------------------------------------------------------------------
# Leituras do ambiente (só leitura)
# ---------------------------------------------------------------------------------------------

# Valor de uma variável do .env por grep e cut (sem source), em ENV_VALUE; nunca impresso.
read_env_value() {
  local line
  # Aceita "export NOME=valor". Valor entre aspas vai até a aspa de fechamento; sem aspas, um " #"
  # começa comentário (como no dotenv).
  line=$(grep -E "^(export[[:space:]]+)?$1=" "$ENV_FILE" | tail -n 1 | sed -E 's/^export[[:space:]]+//' || true)
  ENV_VALUE=${line#*=}
  ENV_VALUE=${ENV_VALUE%$'\r'}
  if [[ $ENV_VALUE == \"* ]]; then
    ENV_VALUE=${ENV_VALUE#\"}
    ENV_VALUE=${ENV_VALUE%%\"*}
  elif [[ $ENV_VALUE == \'* ]]; then
    ENV_VALUE=${ENV_VALUE#\'}
    ENV_VALUE=${ENV_VALUE%%\'*}
  else
    ENV_VALUE=${ENV_VALUE%%[[:space:]]\#*}
    ENV_VALUE=${ENV_VALUE%"${ENV_VALUE##*[![:space:]]}"}
  fi
}

# Lê um SHA de um arquivo de estado em SHA_VALUE (vazio se não existe).
read_sha_file() {
  SHA_VALUE=''
  if [[ -f $1 ]]; then
    IFS= read -r SHA_VALUE <"$1" || true
  fi
  if [[ -n $SHA_VALUE && ! $SHA_VALUE =~ ^[0-9a-f]{40}$ ]]; then
    die1 "arquivo de estado inválido: $1"
  fi
}

write_sha_file() {
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" >"$1.tmp"
  mv -f "$1.tmp" "$1"
}

# Estado do app no PM2: PM2_STATUS (vazio se o app não existe) e PM2_RESTARTS.
read_pm2() {
  local line
  PM2_STATUS=''
  PM2_RESTARTS=0
  line=$(
    pm2 jlist 9>&- 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      // O PM2 pode imprimir avisos antes do JSON (linhas que também começam com "[").
      for (const text of s.split("\n")) {
        if (!text.startsWith("[")) continue;
        try {
          const app = JSON.parse(text).find((p) => p.name === process.argv[1]);
          if (app && app.pm2_env) {
            process.stdout.write(String(app.pm2_env.status) + " " + String(app.pm2_env.restart_time || 0));
          }
          break;
        } catch (e) {}
      }
    });' "$PM2_APP"
  ) || line=''
  if [[ -n $line ]]; then
    PM2_STATUS=${line%% *}
    PM2_RESTARTS=${line##* }
  fi
}

http_code() {
  local code
  # Primeiro argumento: a URL (depois de "--"); os demais são opções extras do curl.
  code=$(curl -sS -o /dev/null --max-time 3 -w '%{http_code}' "${@:2}" -- "$1" 9>&- 2>/dev/null) || code=000
  printf '%s' "$code"
}

probe_health() {
  [[ $(http_code "$HEALTH_URL") == 200 && $(http_code "$READY_URL") == 200 ]]
}

# Confere https://<host>/ resolvido para 127.0.0.1 contra a lista de códigos aceitos.
host_ok() {
  local host=$1 codes=$2 label=$3 code ok
  local -a accepted
  code=$(http_code "https://$host/" --resolve "$host:443:127.0.0.1")
  IFS=, read -ra accepted <<<"$codes"
  for ok in "${accepted[@]}"; do
    if [[ $code == "$ok" ]]; then
      return 0
    fi
  done
  log "o $label respondeu $code por 127.0.0.1 (aceitos: $codes)"
  return 1
}

site_ok() {
  host_ok "$SITE_HOST" "$SITE_OK_CODES" site
}

# Admin da plataforma (spec 044, E4): conferido só quando o alvo tem ADMIN_HOST (o dono o define
# depois de instalar o nginx do admin) e a versão publicada tem o app.
admin_ok() {
  [[ -n $ADMIN_HOST ]] || return 0
  has_static_app admin || return 0
  host_ok "$ADMIN_HOST" "$ADMIN_OK_CODES" admin
}

node_major_of_tree() {
  local want have
  IFS= read -r want <"$APP_DIR/.nvmrc" || want=''
  want=${want%$'\r'}
  want=${want#v}
  want=${want%%.*}
  have=$(node -v)
  have=${have#v}
  have=${have%%.*}
  if [[ -z $want || $want != "$have" ]]; then
    log "versão do Node ($have) diferente da do .nvmrc (${want:-ausente})"
    return 1
  fi
}

pnpm_version_of_tree() {
  local want have
  want=$(grep -o '"packageManager": *"pnpm@[^"]*"' "$APP_DIR/package.json" | sed -E 's/.*pnpm@([^"]*)"/\1/' || true)
  have=$(pnpm --version)
  if [[ -z $want || $want != "$have" ]]; then
    log "versão do pnpm ($have) diferente da do packageManager (${want:-ausente})"
    return 1
  fi
}

# ---------------------------------------------------------------------------------------------
# Trava e pré-condições
# ---------------------------------------------------------------------------------------------

# Uma trava só para os dois ambientes: compilam no mesmo servidor, que tem pouca memória.
acquire_lock() {
  command -v flock >/dev/null 2>&1 || die1 'flock não encontrado no servidor'
  exec 9>"$LOCK_FILE"
  flock -n 9 || die1 'há outra execução do deploy em andamento (trava global)'
}

check_preconditions() {
  local tool
  for tool in git pm2 pnpm node curl nice timeout df awk; do
    command -v "$tool" >/dev/null 2>&1 || die1 "comando ausente: $tool"
  done
  [[ -d $APP_DIR/.git ]] || die1 "$APP_DIR não é um clone do Git"
  if [[ -n $(git -C "$APP_DIR" status --porcelain) ]]; then
    die1 'a árvore do Git não está limpa (git status --porcelain); resolva à mão antes de implantar'
  fi
  node_major_of_tree || die1 'versão do Node incompatível'
  pnpm_version_of_tree || die1 'versão do pnpm incompatível'
  [[ -f $ENV_FILE && -r $ENV_FILE ]] || die1 'arquivo de ambiente ausente ou ilegível'
  [[ $(stat -c %a "$ENV_FILE") == 600 ]] || die1 'o arquivo de ambiente precisa ter modo 600'
  local free_kb
  free_kb=$(df -Pk "$APP_DIR" | awk 'NR==2 {print $4}')
  [[ $free_kb =~ ^[0-9]+$ ]] || die1 'não consegui medir o espaço livre'
  ((free_kb >= MIN_FREE_KB)) || die1 "espaço livre insuficiente: ${free_kb} KB (mínimo ${MIN_FREE_KB} KB)"
  read_pm2
  if [[ -z $PM2_STATUS && $ADOPT != true ]]; then
    die1 "o app $PM2_APP não existe no PM2 (na primeira vez use --adopt)"
  fi
}

# Versão em execução: o estado registrado tem de bater com o HEAD (senão uma execução anterior morreu
# no meio ou alguém mexeu à mão).
load_state() {
  HEAD_SHA=$(git -C "$APP_DIR" rev-parse HEAD)
  read_sha_file "$STATE_DIR/current"
  CURRENT_SHA=$SHA_VALUE
  read_sha_file "$STATE_DIR/previous"
  PREVIOUS_SHA=$SHA_VALUE
  if [[ -z $CURRENT_SHA ]]; then
    if [[ $ADOPT == true ]]; then
      ADOPT_PENDING=true
    elif [[ $DRY_RUN == true ]]; then
      log 'AVISO: nenhuma versão registrada; o deploy real exige --adopt na primeira vez'
    else
      die1 'nenhuma versão registrada para este ambiente; na primeira execução use --adopt'
    fi
    CURRENT_SHA=$HEAD_SHA
  elif [[ $CURRENT_SHA != "$HEAD_SHA" ]]; then
    if [[ $ADOPT == true ]]; then
      ADOPT_PENDING=true
      CURRENT_SHA=$HEAD_SHA
    elif [[ $FORCE == true ]]; then
      # Recuperação de uma execução que morreu no meio: segue com o --ref pedido; a versão de volta
      # em caso de falha é a REGISTRADA (a que o estado diz que está em execução), não o HEAD.
      log "AVISO: o HEAD ($(short "$HEAD_SHA")) difere da versão registrada ($(short "$CURRENT_SHA")); seguindo por causa do --force. A versão de volta, se falhar, é a registrada"
    else
      die1 "o HEAD ($(short "$HEAD_SHA")) difere da versão registrada ($(short "$CURRENT_SHA")); uma execução anterior pode ter parado no meio. Rode --ref $CURRENT_SHA --force"
    fi
  fi
  PREV_SHA=$CURRENT_SHA
}

check_current_health() {
  if [[ -z $PM2_STATUS ]]; then
    log 'AVISO: app ausente no PM2 (adoção); a saúde atual não foi conferida'
    return 0
  fi
  if ! probe_health; then
    if [[ $FORCE == true ]]; then
      log 'AVISO: o sistema já não responde antes do deploy; seguindo por causa do --force'
    else
      die1 'o sistema já não responde (health) antes do deploy; conserte ou use --force'
    fi
  fi
}

resolve_ref() {
  local candidate sha
  if [[ $USE_PREVIOUS == true ]]; then
    [[ -n $PREVIOUS_SHA ]] || die1 'não há versão anterior registrada para --previous'
    TARGET_SHA=$PREVIOUS_SHA
  elif [[ $AUTO == true ]]; then
    # No automático o --ref é o próprio SHA: nunca uma branch ou tag que por acaso tenha esse nome.
    TARGET_SHA=$(git -C "$APP_DIR" rev-parse --verify --quiet "$REF^{commit}") || TARGET_SHA=''
    [[ -n $TARGET_SHA ]] || die1 "não encontrei o commit $REF depois do fetch"
    [[ $TARGET_SHA == "$REF" ]] || die1 'modo automático: o --ref não resolveu para o próprio SHA pedido; nada foi alterado'
  else
    for candidate in "refs/remotes/origin/$REF" "refs/tags/$REF" "$REF"; do
      if sha=$(git -C "$APP_DIR" rev-parse --verify --quiet "$candidate^{commit}"); then
        TARGET_SHA=$sha
        break
      fi
    done
    [[ -n $TARGET_SHA ]] || die1 "não encontrei a referência $REF depois do fetch"
  fi
  git -C "$APP_DIR" cat-file -e "$TARGET_SHA^{commit}" || die1 'a versão pedida não é um commit conhecido'
}

# Só com --auto (E3): o SHA pedido precisa estar na main (depois do fetch) e não pode ser mais antigo
# que a versão registrada. Igual à registrada segue para "já está nessa versão" (saída 0).
check_auto_rules() {
  [[ $AUTO == true ]] || return 0
  git -C "$APP_DIR" rev-parse --verify --quiet 'refs/remotes/origin/main^{commit}' >/dev/null \
    || die1 'modo automático: origin/main não encontrada depois do fetch'
  if ! git -C "$APP_DIR" merge-base --is-ancestor "$TARGET_SHA" refs/remotes/origin/main; then
    die1 "modo automático: $(short "$TARGET_SHA") não está na main; nada foi alterado"
  fi
  if ! git -C "$APP_DIR" merge-base --is-ancestor "$PREV_SHA" "$TARGET_SHA"; then
    die1 "modo automático: $(short "$TARGET_SHA") é mais antigo que a versão em execução ($(short "$PREV_SHA")) ou não descende dela; o automático nunca volta. Nada foi alterado"
  fi
}

check_staged_rule() {
  [[ $ENV_NAME == production && $REQUIRE_STAGED == true ]] || return 0
  local staged label=nenhum
  read_sha_file "$STATE_ROOT/staging/current"
  staged=$SHA_VALUE
  if [[ -n $staged ]]; then
    label=$(short "$staged")
  fi
  if [[ $ALLOW_UNSTAGED == true ]]; then
    log "AVISO: produção sem passar pelo staging (--allow-unstaged); o staging está em $label"
    return 0
  fi
  if [[ $staged != "$TARGET_SHA" ]]; then
    die1 "a produção só aceita o SHA que já está no staging (staging: $label; pedido: $(short "$TARGET_SHA")). Ensaie no staging ou use --allow-unstaged (emergência)"
  fi
}

# ---------------------------------------------------------------------------------------------
# Varredura de migrations (alarme por texto, não prova)
# ---------------------------------------------------------------------------------------------

readonly BREAKING_PATTERN='\b(DROP|RENAME|TRUNCATE)\b|SET[[:space:]]+NOT[[:space:]]+NULL|DELETE[[:space:]]+FROM|ALTER[[:space:]]+COLUMN[^;]*TYPE\b'

scan_migrations() {
  local -a files
  local file name sql stripped found
  MIGRATION_NAMES=()
  BREAKING_NAMES=()
  UNAPPROVED_NAMES=()
  BREAKING_KEYWORDS=''
  mapfile -t files < <(git -C "$APP_DIR" diff --name-only --diff-filter=A "$PREV_SHA" "$TARGET_SHA" -- backend/prisma/migrations)
  for file in "${files[@]}"; do
    [[ $file == */migration.sql ]] || continue
    name=${file%/migration.sql}
    name=${name##*/}
    MIGRATION_NAMES+=("$name")
    sql=$(git -C "$APP_DIR" show "$TARGET_SHA:$file")
    stripped=$(git -C "$APP_DIR" show "$TARGET_SHA:$file" | sed 's/--.*$//' | tr '\n' ' ')
    if grep -Eiq "$BREAKING_PATTERN" <<<"$stripped"; then
      found=$(grep -Eio "$BREAKING_PATTERN" <<<"$stripped" | tr '[:lower:]' '[:upper:]' | sort -u | tr '\n' ',' || true)
      BREAKING_NAMES+=("$name")
      BREAKING_KEYWORDS+="$name: ${found%,}; "
      if ! grep -Eq '^-- breaking-approved: .+' <<<"$sql"; then
        UNAPPROVED_NAMES+=("$name")
      fi
    fi
  done
}

enforce_migration_policy() {
  if ((${#UNAPPROVED_NAMES[@]} > 0)); then
    die1 "migration não aditiva sem a marca '-- breaking-approved: <motivo>': ${UNAPPROVED_NAMES[*]} (${BREAKING_KEYWORDS}). Nada foi alterado. Veja a política em docs/ops/deploy.md"
  fi
  if ((${#BREAKING_NAMES[@]} > 0)) && [[ $ALLOW_BREAKING != true ]]; then
    die1 "migration marcada como destrutiva (${BREAKING_NAMES[*]}) exige --allow-breaking, backup antes e não tem rollback automático"
  fi
  if ((${#MIGRATION_NAMES[@]} > 0)) && [[ -n $PRE_MIGRATION_BACKUP && ! -x $PRE_MIGRATION_BACKUP ]]; then
    die1 'há migration a aplicar e o programa de backup do alvo não existe ou não é executável'
  fi
  if ((${#BREAKING_NAMES[@]} > 0)) && [[ $ENV_NAME == production && -z $PRE_MIGRATION_BACKUP ]]; then
    die1 'migration destrutiva em produção exige PRE_MIGRATION_BACKUP no alvo'
  fi
}

print_plan() {
  local free_kb name classification origin="ref $REF"
  free_kb=$(df -Pk "$APP_DIR" | awk 'NR==2 {print $4}')
  if [[ $USE_PREVIOUS == true ]]; then
    origin='versão anterior registrada (--previous)'
  fi
  log "PLANO: $(short "$PREV_SHA") -> $(short "$TARGET_SHA") ($origin)"
  if ((${#MIGRATION_NAMES[@]} == 0)); then
    log 'migrations que entram: nenhuma'
  else
    for name in "${MIGRATION_NAMES[@]}"; do
      classification='aditiva (varredura por texto, confira a compatibilidade com a versão anterior)'
      if [[ " ${BREAKING_NAMES[*]} " == *" $name "* ]]; then
        classification='DESTRUTIVA (marcada)'
      fi
      log "migration que entra: $name: $classification"
    done
  fi
  log "node $(node -v), pnpm $(pnpm --version), espaço livre ${free_kb} KB, PM2 ${PM2_APP}: ${PM2_STATUS:-ausente} (reinícios ${PM2_RESTARTS}), API na porta $PORT"
  log "backup antes de migration: ${PRE_MIGRATION_BACKUP:-nenhum}"
  if git -C "$APP_DIR" cat-file -e "$TARGET_SHA:admin/package.json" 2>/dev/null; then
    log "admin da plataforma: publicado junto com o site (conferência por https: ${ADMIN_HOST:-nenhuma, alvo sem ADMIN_HOST})"
  else
    log 'admin da plataforma: a versão pedida não tem admin/; o admin publicado não muda'
  fi
}

# ---------------------------------------------------------------------------------------------
# Preparar, restaurar, migrar
# ---------------------------------------------------------------------------------------------

generate_client() {
  read_env_value DATABASE_URL
  [[ -n $ENV_VALUE ]] || { log 'o arquivo de ambiente não define a URL do banco'; return 1; }
  (
    # A URL do banco existe só dentro deste subshell, de propósito (nunca vaza para o resto do script).
    # shellcheck disable=SC2030,SC2031
    export DATABASE_URL=$ENV_VALUE
    cd "$APP_DIR" && run_cmd pnpm db:generate
  )
}

build_backend() {
  (
    # umask 022 só para o que o build gera (o 077 global é para log, estado, trava e backup).
    umask 022
    cd "$APP_DIR/backend" || exit 1
    rm -rf dist.next
    run_cmd nice -n 10 env "NODE_OPTIONS=--max-old-space-size=$BUILD_MEMORY_MB" \
      pnpm --filter soprei-backend exec tsc -p tsconfig.build.json --outDir dist.next
  )
}

# Verdadeiro se o app estático "$1" faz parte desta publicação.
has_static_app() {
  local app
  for app in "${STATIC_APPS[@]}"; do
    if [[ $app == "$1" ]]; then
      return 0
    fi
  done
  return 1
}

# Compila um app estático ("$1": pasta, "$2": pacote) em <pasta>/releases/$NEW_RELEASE.
build_static_app() {
  local dir=$1 package=$2
  (
    # O nginx (outro usuário) precisa ler a release: umask 022 aqui e modo explícito depois.
    umask 022
    cd "$APP_DIR/$dir" || exit 1
    # A própria pasta do app também: o git a cria com o umask 077 do script quando ela chega numa versão
    # nova (foi o caso do admin/ na produção, em 2026-11-24: 403 no nginx até um chmod à mão).
    chmod 755 . || exit 1
    mkdir -p releases || exit 1
    chmod 755 releases || exit 1
    run_cmd nice -n 10 env "NODE_OPTIONS=--max-old-space-size=$BUILD_MEMORY_MB" \
      pnpm --filter "$package" exec tsc --noEmit || exit 1
    run_cmd nice -n 10 env "NODE_OPTIONS=--max-old-space-size=$BUILD_MEMORY_MB" \
      pnpm --filter "$package" exec vite build --outDir "$APP_DIR/$dir/releases/$NEW_RELEASE" || exit 1
    chmod -R u=rwX,go=rX "releases/$NEW_RELEASE"
  )
}

# O site e, se a versão tem a pasta admin/ (spec 044, E4), o admin da plataforma: mesma release, mesma
# troca e mesmo rollback. Versão anterior ao admin: o admin publicado fica como está.
build_frontend() {
  local stamp app
  stamp=$(date -u +%Y%m%d%H%M%S)
  NEW_RELEASE="${TARGET_SHA:0:12}-$stamp"
  STATIC_APPS=(frontend)
  if [[ -f $APP_DIR/admin/package.json ]]; then
    STATIC_APPS+=(admin)
  else
    log 'AVISO: esta versão não tem o app admin/ (anterior à spec 044); o admin publicado não muda'
  fi
  for app in "${STATIC_APPS[@]}"; do
    printf -v "SWITCHED_$app" '%s' false
    printf -v "LEGACY_MOVED_$app" '%s' false
    printf -v "PREV_RELEASE_$app" '%s' ''
  done
  build_static_app frontend soprei-frontend || return 1
  if has_static_app admin; then
    build_static_app admin soprei-admin || return 1
  fi
}

# Coloca a árvore na versão pedida e compila nas pastas de espera; o processo em execução não é tocado.
prepare_version() {
  local sha=$1
  TREE_CHANGED=true
  run_cmd git -C "$APP_DIR" checkout --detach -q "$sha" || return 1
  node_major_of_tree || return 1
  (cd "$APP_DIR" && run_cmd pnpm install --frozen-lockfile) || return 1
  generate_client || return 1
  build_backend || return 1
}

cleanup_waiting() {
  local app switched
  rm -rf "$APP_DIR/backend/dist.next"
  [[ -n $NEW_RELEASE ]] || return 0
  for app in "${STATIC_APPS[@]}"; do
    switched="SWITCHED_$app"
    if [[ ${!switched:-false} != true ]]; then
      rm -rf "${APP_DIR:?}/$app/releases/$NEW_RELEASE"
    fi
  done
}

# Falhas antes de trocar: devolve a árvore à versão anterior e sai com 2 (ou 3 se não conseguir).
restore_tree() {
  log "restaurando a árvore para $(short "$PREV_SHA")"
  run_cmd git -C "$APP_DIR" checkout --detach -q "$PREV_SHA" || return 1
  (cd "$APP_DIR" && run_cmd pnpm install --frozen-lockfile) || return 1
  generate_client || return 1
}

manual_intervention() {
  local head
  head=$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || true)
  read_pm2
  log "INTERVENÇÃO MANUAL: $1"
  log "estado: git HEAD=${head:-?} (versão anterior: $(short "$PREV_SHA"), alvo: $(short "$TARGET_SHA")); PM2 ${PM2_APP}=${PM2_STATUS:-ausente} reinícios=${PM2_RESTARTS}"
  if ((${#MIGRATION_NAMES[@]} > 0)); then
    log "migrations desta tentativa (NÃO revertidas, conferir o banco): ${MIGRATION_NAMES[*]}"
  fi
  log "conferir: git -C $APP_DIR status; pm2 describe $PM2_APP; (cd $APP_DIR/backend && pnpm exec prisma migrate status); log em $LOG_FILE"
  log 'o script não tenta de novo'
  exit 3
}

abort_before_swap() {
  local reason=$1 code=${2:-2}
  trap '' INT TERM
  log "FALHA antes de trocar a versão: $reason"
  cleanup_waiting
  if [[ $TREE_CHANGED == true ]]; then
    if restore_tree; then
      log "árvore restaurada; o processo em execução não foi tocado (versão $(short "$PREV_SHA"))"
    else
      manual_intervention 'não consegui restaurar a árvore do Git'
    fi
  fi
  exit "$code"
}

# Chamada pelo `trap on_unexpected_error ERR` em run_deploy (o shellcheck não vê a chamada pelo trap).
# shellcheck disable=SC2329
on_unexpected_error() {
  local line=${BASH_LINENO[0]:-desconhecida}
  trap - ERR
  log "ERRO inesperado no script (linha $line)"
  if [[ $POINT_OF_NO_RETURN == true ]]; then
    post_swap_failure 'erro inesperado no script'
  fi
  abort_before_swap 'erro inesperado no script'
}

# Chamada pelo `trap on_interrupt INT TERM` em run_deploy (o shellcheck não vê a chamada pelo trap).
# shellcheck disable=SC2329
on_interrupt() {
  abort_before_swap 'execução interrompida (sinal)' 1
}

run_pre_migration_backup() {
  [[ -n $PRE_MIGRATION_BACKUP ]] || return 0
  ((${#MIGRATION_NAMES[@]} > 0)) || return 0
  log 'executando o backup antes da migration'
  run_cmd "$PRE_MIGRATION_BACKUP"
}

run_migrations() {
  read_env_value DATABASE_URL
  [[ -n $ENV_VALUE ]] || { log 'o arquivo de ambiente não define a URL do banco'; return 1; }
  (
    # A URL do banco existe só dentro deste subshell, de propósito (nunca vaza para o resto do script).
    # shellcheck disable=SC2030,SC2031
    export DATABASE_URL=$ENV_VALUE
    cd "$APP_DIR/backend" && run_cmd timeout "$MIGRATE_TIMEOUT_SECONDS" pnpm db:migrate:deploy
  )
}

# ---------------------------------------------------------------------------------------------
# Trocar, esperar a saúde, trocar o site
# ---------------------------------------------------------------------------------------------

# Troca dist.next por dist guardando o dist antigo em "$1". Cada mv é conferido (esta função roda em
# contexto de || e o set -e não vale): se o dist antigo não saiu do lugar, mv dist.next dist poria a
# pasta nova DENTRO dele e a "troca" falsa passaria. Falhou no meio: devolve o dist antigo.
swap_dist_dirs() {
  local old=$1
  (
    cd "$APP_DIR/backend" || exit 1
    rm -rf "$old" || exit 1
    if [[ -d dist ]]; then
      if ! mv dist "$old" || [[ -e dist ]]; then
        exit 1
      fi
    fi
    if ! mv -T dist.next dist || [[ -e dist.next ]]; then
      if [[ ! -e dist && -d $old ]]; then
        mv "$old" dist || true
      fi
      exit 1
    fi
  )
}

swap_backend() {
  swap_dist_dirs dist.prev
}

reload_app() {
  now_ms
  RELOAD_START_MS=$NOW_MS
  run_cmd pm2 startOrReload "$APP_DIR/deploy/ecosystem.config.cjs" --only "$PM2_APP"
}

# Grava a lista do PM2 depois de um reload que deu certo: sem isso, um reinício do servidor traria
# de volta a configuração anterior do app (kill_timeout, cwd...). Falhar aqui não desfaz o deploy.
save_pm2_list() {
  run_cmd pm2 save || log 'AVISO: pm2 save falhou; rode "pm2 save" à mão para o PM2 voltar com esta configuração depois de um reinício'
}

# Espera a saúde: HEALTH_STABLE_COUNT respostas boas seguidas, app online e sem reinício além do
# da própria troca (pega o laço de reinício, que um 200 só não pega). Primeiro argumento "inject":
# a primeira espera pode falhar de propósito (staging).
wait_healthy() {
  local mode=$1 baseline good=0 deadline
  if [[ $mode == inject && $INJECT_HEALTH_FAILURE == true ]]; then
    log 'falha de saúde INJETADA (--inject-health-failure): simulando a versão nova que não responde'
    return 1
  fi
  read_pm2
  baseline=$PM2_RESTARTS
  deadline=$(($(date +%s) + HEALTH_TIMEOUT_SECONDS))
  while (($(date +%s) < deadline)); do
    read_pm2
    if ((PM2_RESTARTS > baseline)); then
      log "o PM2 reiniciou o processo durante a espera (${baseline} -> ${PM2_RESTARTS}): laço de reinício"
      return 1
    fi
    if [[ $PM2_STATUS == online ]] && probe_health; then
      if ((good == 0)); then
        now_ms
        FIRST_GOOD_MS=$NOW_MS
      fi
      good=$((good + 1))
      if ((good >= HEALTH_STABLE_COUNT)); then
        log "saúde confirmada (${good} respostas boas seguidas, app online, sem reinício)"
        return 0
      fi
    else
      good=0
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
  done
  log "a saúde não se confirmou em ${HEALTH_TIMEOUT_SECONDS}s (status do PM2: ${PM2_STATUS:-ausente})"
  return 1
}

# Rótulo de um app estático nas mensagens ("site" para o frontend).
static_label() {
  if [[ $1 == frontend ]]; then
    printf 'site'
  else
    printf '%s' "$1"
  fi
}

# Troca o atalho <app>/dist para a release nova e guarda o que havia em PREV_RELEASE_<app>.
switch_static() {
  local app=$1 fe="$APP_DIR/$1" label stamp prev=''
  label=$(static_label "$app")
  printf -v "PREV_RELEASE_$app" '%s' ''
  printf -v "LEGACY_MOVED_$app" '%s' false
  # Valida e prepara TUDO antes de mexer na pasta atual (se algo falhar aqui, nada mudou).
  [[ -f $fe/releases/$NEW_RELEASE/index.html ]] || { log "a release nova do $label não tem index.html"; return 1; }
  (umask 022 && mkdir -p "$fe/releases") || return 1
  chmod 755 "$fe/releases" || return 1
  rm -rf "$fe/.dist.new"
  ln -s "releases/$NEW_RELEASE" "$fe/.dist.new" || return 1
  if [[ -L $fe/dist ]]; then
    prev=$(readlink "$fe/dist")
  elif [[ -d $fe/dist ]]; then
    # Primeira vez: o app era uma pasta real; vira uma release e passa a ser servido por atalho.
    stamp=$(date -u +%Y%m%d%H%M%S)
    prev="releases/legacy-$stamp"
    if ! mv "$fe/dist" "$fe/$prev"; then
      rm -rf "$fe/.dist.new"
      return 1
    fi
    printf -v "LEGACY_MOVED_$app" '%s' true
    chmod 755 "$fe/$prev" || true
  fi
  printf -v "PREV_RELEASE_$app" '%s' "$prev"
  printf -v "SWITCHED_$app" '%s' true
  if ! mv -T "$fe/.dist.new" "$fe/dist"; then
    log "não consegui colocar o atalho do $label no lugar"
    return 1
  fi
}

# Troca o site e, quando publicado junto, o admin (spec 044, E4).
switch_site() {
  local app
  for app in "${STATIC_APPS[@]}"; do
    switch_static "$app" || return 1
  done
}

# Devolve um app estático ao que era antes de switch_static (inclusive a pasta real da primeira vez).
restore_static() {
  local app=$1 fe="$APP_DIR/$1" label prev
  local switched="SWITCHED_$1" legacy="LEGACY_MOVED_$1" prev_name="PREV_RELEASE_$1"
  [[ ${!switched:-false} == true || ${!legacy:-false} == true ]] || return 0
  label=$(static_label "$app")
  prev=${!prev_name:-}
  rm -rf "$fe/.dist.new"
  if [[ ${!legacy:-false} == true ]]; then
    rm -f "$fe/dist"
    mv "$fe/$prev" "$fe/dist" || return 1
    printf -v "LEGACY_MOVED_$app" '%s' false
  elif [[ -n $prev ]]; then
    ln -s "$prev" "$fe/.dist.new" || return 1
    mv -T "$fe/.dist.new" "$fe/dist" || return 1
  else
    rm -f "$fe/dist"
  fi
  rm -rf "${fe:?}/releases/$NEW_RELEASE"
  printf -v "SWITCHED_$app" '%s' false
  log "$label restaurado para ${prev:-nenhuma release}"
}

# Devolve o site e o admin ao que eram; tenta cada um mesmo que o outro falhe.
restore_site() {
  local app rc=0
  for app in "${STATIC_APPS[@]}"; do
    restore_static "$app" || rc=1
  done
  return "$rc"
}

# Mantém as 3 releases mais novas de cada app estático (e nunca apaga a que está no ar).
prune_releases() {
  local app fe live dir count
  for app in "${STATIC_APPS[@]}"; do
    fe="$APP_DIR/$app"
    count=0
    live=$(readlink "$fe/dist" 2>/dev/null || true)
    [[ -d $fe/releases ]] || continue
    while IFS= read -r dir; do
      [[ -n $dir ]] || continue
      count=$((count + 1))
      if ((count > 3)) && [[ releases/${dir##*/} != "$live" ]]; then
        rm -rf "${fe:?}/releases/${dir##*/}"
      fi
    done < <(find "$fe/releases" -mindepth 1 -maxdepth 1 -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
  done
}

# ---------------------------------------------------------------------------------------------
# Rollback do código (migration NÃO é revertida)
# ---------------------------------------------------------------------------------------------

rollback_code() {
  log "ROLLBACK: refazendo o caminho para $(short "$PREV_SHA")"
  trap '' INT TERM
  restore_site || return 1
  restore_tree || return 1
  build_backend || return 1
  swap_dist_dirs dist.failed || return 1
  reload_app || return 1
  wait_healthy rollback || return 1
}

list_unreverted_migrations() {
  if ((${#MIGRATION_NAMES[@]} > 0)); then
    log "migrations aplicadas nesta tentativa e NÃO revertidas: ${MIGRATION_NAMES[*]}"
    log 'o código anterior segue compatível se a migration for aditiva; confira conforme docs/ops/deploy.md'
  fi
}

post_swap_failure() {
  log "FALHA: $1"
  if [[ $ALLOW_BREAKING == true ]]; then
    manual_intervention 'falha com --allow-breaking: não há rollback automático (o código antigo pode não funcionar sobre o banco alterado). Restaure o backup feito antes da migration ou corrija para a frente'
  fi
  if rollback_code; then
    save_pm2_list
    log "DEPLOY FALHOU; VOLTEI PARA $(short "$PREV_SHA")"
    list_unreverted_migrations
    exit 2
  fi
  manual_intervention 'o rollback também falhou'
}

# ---------------------------------------------------------------------------------------------
# Fluxo principal
# ---------------------------------------------------------------------------------------------

run_deploy() {
  local started=$SECONDS mode=manual
  trap '' HUP PIPE
  trap on_interrupt INT TERM
  trap on_unexpected_error ERR
  if [[ $AUTO == true ]]; then mode=auto; fi
  log "início (modo=$mode, ref $REF, previous=$USE_PREVIOUS, dry-run=$DRY_RUN, force=$FORCE, adopt=$ADOPT, allow-breaking=$ALLOW_BREAKING)"

  acquire_lock
  check_preconditions
  load_state
  check_current_health

  log 'buscando a versão pedida (git fetch)'
  run_cmd git -C "$APP_DIR" fetch --prune --tags origin || die1 'git fetch falhou (rede ou chave); nada foi alterado'
  resolve_ref
  check_auto_rules
  check_staged_rule
  # Sem o app no PM2 (adoção de um ambiente novo) nada está rodando: implanta mesmo sendo o mesmo SHA.
  if [[ $TARGET_SHA == "$PREV_SHA" && $FORCE != true && -n $PM2_STATUS ]]; then
    # Adoção de um servidor já atualizado à mão: registra a versão em execução mesmo sem nada a
    # implantar; sem isso o próximo deploy recusaria por falta de versão registrada.
    if [[ $ADOPT_PENDING == true ]]; then
      if [[ $DRY_RUN == true ]]; then
        log "o deploy real registraria $(short "$PREV_SHA") como a versão em execução (adoção)"
      else
        write_sha_file "$STATE_DIR/current" "$PREV_SHA" || die1 'não consegui gravar a versão em execução'
        log "versão em execução registrada (adoção): $(short "$PREV_SHA")"
      fi
    fi
    log "já está nessa versão ($(short "$TARGET_SHA")); nada a fazer (--force reimplanta)"
    exit 0
  fi
  scan_migrations
  enforce_migration_policy

  if [[ $DRY_RUN == true ]]; then
    print_plan
    log 'DRY-RUN concluído; nada foi alterado'
    exit 0
  fi
  print_plan

  if [[ $ADOPT_PENDING == true ]]; then
    write_sha_file "$STATE_DIR/current" "$PREV_SHA"
    log "versão em execução registrada (adoção): $(short "$PREV_SHA")"
  fi

  # A partir daqui o script altera o servidor.
  log 'preparando a versão nova (o processo atual segue no ar)'
  prepare_version "$TARGET_SHA" || abort_before_swap 'instalação, geração do cliente ou build do backend falhou'

  log 'validando o ambiente com o build novo (config:check)'
  if ! (cd "$APP_DIR/backend" && run_cmd node dist.next/infrastructure/config/check-cli.js); then
    abort_before_swap 'o arquivo de ambiente não vale para a versão nova (variáveis listadas acima); nenhuma migration foi aplicada e o processo não foi tocado'
  fi

  build_frontend || abort_before_swap 'o build do site ou do admin falhou'

  # Ponto sem volta: um deploy não pode parar entre a migration e a saúde.
  trap '' INT TERM
  POINT_OF_NO_RETURN=true
  if ((${#MIGRATION_NAMES[@]} > 0)); then
    run_pre_migration_backup || abort_before_swap 'o backup antes da migration falhou; a migration não foi aplicada'
  fi
  if ! run_migrations; then
    log 'ATENÇÃO: o banco pode ter ficado com migration parcial (o Prisma a registra como falha e o próximo deploy recusa até alguém resolver). Conferir: (cd backend && pnpm exec prisma migrate status)'
    abort_before_swap 'db:migrate:deploy falhou ou estourou o prazo; nada foi trocado'
  fi

  # Falha aqui (depois da migration, antes de recarregar): o app antigo segue no ar e saudável, nada
  # foi trocado; só a árvore volta (sem recompilar o anterior e sem recarregar o PM2).
  if ! swap_backend; then
    list_unreverted_migrations
    abort_before_swap 'a troca da pasta compilada falhou (o processo em execução não foi tocado)'
  fi
  reload_app || post_swap_failure 'o PM2 não conseguiu recarregar o app'
  wait_healthy inject || post_swap_failure 'o sistema novo não ficou saudável'
  switch_site || post_swap_failure 'a troca do site falhou'
  site_ok || post_swap_failure 'o site novo não respondeu'
  admin_ok || post_swap_failure 'o admin novo não respondeu'

  # Concluído: daqui em diante um erro não é motivo de rollback.
  trap - ERR
  POINT_OF_NO_RETURN=false
  prune_releases || log 'AVISO: não consegui apagar releases antigas do site ou do admin'
  if ! write_sha_file "$STATE_DIR/previous" "$PREV_SHA" || ! write_sha_file "$STATE_DIR/current" "$TARGET_SHA"; then
    manual_intervention 'o deploy foi concluído, mas não consegui gravar o estado; grave o SHA atual em current à mão'
  fi
  save_pm2_list

  local other other_label=''
  if [[ $ENV_NAME == production ]]; then other=staging; else other=production; fi
  read_sha_file "$STATE_ROOT/$other/current"
  other_label=${SHA_VALUE:+$(short "$SHA_VALUE")}
  local migrations_label=${MIGRATION_NAMES[*]:-nenhuma}
  local downtime_ms=$((FIRST_GOOD_MS - RELOAD_START_MS))
  log "RESUMO: concluído; $(short "$PREV_SHA") -> $(short "$TARGET_SHA"); migrations aplicadas: ${migrations_label}; tempo total $((SECONDS - started))s; indisponibilidade medida (do reload à primeira saúde boa) ${downtime_ms} ms; ${other} está em ${other_label:-nenhum}"
  exit 0
}

main() {
  local rc
  parse_args "$@"
  RUN_USER=$(id -un)
  load_target
  open_log

  # Toda a saída passa pelo filtro de redação e vai também ao log. O pipeline roda o deploy num
  # subshell; o código de saída é o dele (PIPESTATUS), não o do filtro.
  # Queda da conexão (deploy pelo SSH sem terminal, job cancelado, rede): quem lê a saída fecha o
  # pipe. Nada aqui pode morrer por SIGPIPE: o filtro e o tee ignoram o sinal, e o tee, com
  # warn-nopipe, para de escrever na saída fechada e SEGUE gravando o log; assim o sed nunca vê o
  # pipe fechado e o deploy vai até o fim (com rollback se precisar).
  set +o pipefail
  run_deploy 2>&1 | (
    trap '' INT TERM HUP PIPE
    redact | tee --output-error=warn-nopipe -a "$LOG_FILE"
  )
  rc=${PIPESTATUS[0]}
  exit "$rc"
}

main "$@"
