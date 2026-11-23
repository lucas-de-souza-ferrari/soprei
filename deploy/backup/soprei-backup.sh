#!/usr/bin/env bash
# Soprei, spec 043: backup diário do banco, cifrado antes de sair do servidor. Uso, instalação e
# restauração em docs/ops/backup.md.
#
#   soprei-backup [--dry-run]
#
# Instale FORA do repositório, como /usr/local/sbin/soprei-backup (dono root, modo 755); um merge não
# reinstala este programa. A configuração fica em /etc/soprei-backup/backup.conf (root, modo 600) e é
# lida como texto, nunca por `source`.
#
# Sequência: pg_dump como o usuário postgres -> cifra com a chave PÚBLICA do age -> envia só o arquivo
# cifrado -> confere o tamanho no destino -> apaga cópias locais antigas -> grava o estado -> avisa o
# serviço de sinal de vida. Este programa nunca apaga nada no destino: a expiração é regra do bucket.
#
# Códigos de saída: 0 concluído; 1 recusado antes de começar (configuração ou uso; nada foi feito);
# 2 um passo falhou (nada antigo foi apagado); 3 outra execução está em andamento.
#
# Regras (a spec 043 e o teste backup-scripts.test.ts as impõem): toda a lógica em funções e `main`
# na última linha; a saída das ferramentas (pg_dump, age, rclone, curl) vai só para o registro privado
# da execução, nunca para a saída deste programa; a credencial do destino fica só na configuração do
# rclone; o modo de rastreamento do shell nunca é ligado.
set -Eeuo pipefail
umask 077
export LC_ALL=C
IFS=$' \t\n'

# Ganchos de teste (o padrão é o caminho de produção); definidos só por quem já controla o ambiente.
CONF_FILE=${SOPREI_BACKUP_CONF:-/etc/soprei-backup/backup.conf}
LOCK_FILE=${SOPREI_BACKUP_LOCK_FILE:-/var/lock/soprei-backup.lock}
RUNUSER=${SOPREI_BACKUP_RUNUSER:-/usr/sbin/runuser}

# Configuração (backup.conf).
DB_NAME=soprei
LOCAL_DIR=/var/backups/soprei
LOCAL_KEEP_DAYS=7
AGE_RECIPIENT=''
REMOTE=''
RCLONE_CONFIG_FILE=/etc/soprei-backup/rclone.conf
PING_URL=''
STATUS_FILE=/var/lib/soprei-backup/status

DRY_RUN=false
RUN_LOG=''
STEP=iniciar
NEW_FILE=''
NEW_SIZE=0
PING_RESULT=none
REMOTE_LISTING=''

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die_config() {
  log "recusado: $*" >&2
  exit 1
}

# Grava o estado em arquivo próprio (hora, resultado, passo, arquivo e tamanho; nenhum segredo).
write_status() {
  local result=$1 dir tmp
  dir=${STATUS_FILE%/*}
  mkdir -p "$dir" || return 0
  tmp="$STATUS_FILE.tmp"
  if {
    printf 'time=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'result=%s\n' "$result"
    printf 'step=%s\n' "$STEP"
    printf 'file=%s\n' "$NEW_FILE"
    printf 'size_bytes=%s\n' "$NEW_SIZE"
    printf 'ping=%s\n' "$PING_RESULT"
  } >"$tmp"; then
    mv -f "$tmp" "$STATUS_FILE"
  else
    rm -f "$tmp"
  fi
}

fail() {
  log "FALHOU no passo \"$STEP\": $*" >&2
  if [[ $DRY_RUN == false ]]; then
    log "detalhe das ferramentas em $RUN_LOG (somente root)" >&2
    write_status failed
  fi
  exit 2
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --dry-run) DRY_RUN=true ;;
      *) die_config "argumento desconhecido (uso: soprei-backup [--dry-run])" ;;
    esac
    shift
  done
}

# Arquivo que guarda configuração ou credencial: só o dono lê. Como root, a conferência é sempre
# feita e o dono precisa ser root; fora de root (testes com dublês) o modo pode ser dispensado.
check_private_file() {
  local file=$1 mode owner
  [[ -f $file && -r $file ]] || die_config "arquivo ausente ou ilegível: $file"
  if ((EUID != 0)) && [[ ${SOPREI_BACKUP_TEST_NO_MODE_CHECK:-} == 1 ]]; then
    return 0
  fi
  mode=$(stat -c %a "$file")
  [[ $mode == 600 || $mode == 400 ]] || die_config "$file precisa ter modo 600 (está $mode)"
  if ((EUID == 0)); then
    owner=$(stat -c %u "$file")
    [[ $owner == 0 ]] || die_config "$file precisa pertencer ao root"
  fi
}

load_conf() {
  local line key value
  check_private_file "$CONF_FILE"
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    case "$line" in '' | '#'*) continue ;; esac
    [[ $line == *=* ]] || die_config 'linha inválida na configuração (esperado CHAVE=valor)'
    key=${line%%=*}
    value=${line#*=}
    [[ $value =~ ^[A-Za-z0-9_./:@%+,~-]*$ ]] || die_config "valor inválido para $key"
    case "$key" in
      DB_NAME) DB_NAME=$value ;;
      LOCAL_DIR) LOCAL_DIR=$value ;;
      LOCAL_KEEP_DAYS) LOCAL_KEEP_DAYS=$value ;;
      AGE_RECIPIENT) AGE_RECIPIENT=$value ;;
      REMOTE) REMOTE=$value ;;
      RCLONE_CONFIG_FILE) RCLONE_CONFIG_FILE=$value ;;
      PING_URL) PING_URL=$value ;;
      STATUS_FILE) STATUS_FILE=$value ;;
      *) die_config "chave desconhecida na configuração: $key" ;;
    esac
  done <"$CONF_FILE"

  [[ $DB_NAME =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die_config 'DB_NAME inválido'
  [[ $LOCAL_KEEP_DAYS =~ ^[1-9][0-9]{0,3}$ ]] || die_config 'LOCAL_KEEP_DAYS inválido'
  [[ $AGE_RECIPIENT =~ ^age1[0-9a-z]{20,}$ ]] || die_config 'AGE_RECIPIENT precisa ser a chave pública do age (age1...)'
  [[ $REMOTE =~ ^[A-Za-z0-9_-]+:[A-Za-z0-9_-][A-Za-z0-9_./-]*$ ]] || die_config 'REMOTE fora do formato nome:bucket/pasta'
  [[ $PING_URL == '' || $PING_URL =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~/-]*)?$ ]] || die_config 'PING_URL inválida'
  local path_key
  for path_key in LOCAL_DIR RCLONE_CONFIG_FILE STATUS_FILE; do
    [[ ${!path_key} =~ ^/[^/]+/[^/]+ ]] || die_config "$path_key precisa ser caminho absoluto com pelo menos dois níveis"
    [[ ${!path_key} != *..* && ${!path_key} != */-* ]] || die_config "$path_key com '..' ou componente começando com '-'"
  done
  [[ $REMOTE != *..* ]] || die_config "REMOTE com '..'"
  REMOTE=${REMOTE%/}
  check_private_file "$RCLONE_CONFIG_FILE"
  RUN_LOG="${STATUS_FILE%/*}/last-run.log"
}

require_tools() {
  local tool
  for tool in age rclone find; do
    command -v "$tool" >/dev/null 2>&1 || die_config "$tool não encontrado"
  done
  [[ -x $RUNUSER ]] || die_config 'runuser não encontrado'
  if [[ -n $PING_URL ]]; then
    command -v curl >/dev/null 2>&1 || die_config 'curl não encontrado (PING_URL definida)'
  fi
}

acquire_lock() {
  command -v flock >/dev/null 2>&1 || die_config 'flock não encontrado'
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log 'há outra execução do backup em andamento; nada foi feito' >&2
    exit 3
  fi
}

prepare_dirs() {
  mkdir -p "$LOCAL_DIR" "${STATUS_FILE%/*}"
  chmod 700 "$LOCAL_DIR"
  : >"$RUN_LOG"
  # Sobras de uma execução morta nunca contam como cópia boa.
  find "$LOCAL_DIR" -maxdepth 1 -type f -name 'soprei-*.tmp' -delete
}

file_size() {
  local size
  size=$(wc -c <"$1")
  printf '%s' "${size//[[:space:]]/}"
}

dump_database() {
  local stamp=$1 tmp="$LOCAL_DIR/soprei-$1.dump.tmp"
  STEP=dump
  log "gerando o dump do banco $DB_NAME"
  "$RUNUSER" -u postgres -- pg_dump -Fc "$DB_NAME" >"$tmp" 2>>"$RUN_LOG" || {
    rm -f "$tmp"
    fail 'o pg_dump terminou com erro'
  }
  [[ -s $tmp ]] || {
    rm -f "$tmp"
    fail 'o pg_dump gerou um arquivo vazio'
  }
  mv "$tmp" "$LOCAL_DIR/soprei-$stamp.dump"
}

encrypt_dump() {
  local stamp=$1 plain="$LOCAL_DIR/soprei-$1.dump" tmp="$LOCAL_DIR/soprei-$1.dump.age.tmp"
  STEP=cifrar
  log 'cifrando o dump'
  age -r "$AGE_RECIPIENT" -o "$tmp" "$plain" >>"$RUN_LOG" 2>&1 || {
    rm -f "$tmp"
    fail 'o age terminou com erro'
  }
  [[ -s $tmp ]] || {
    rm -f "$tmp"
    fail 'o age gerou um arquivo vazio'
  }
  mv "$tmp" "$plain.age"
  NEW_FILE="soprei-$stamp.dump.age"
  NEW_SIZE=$(file_size "$plain.age")
}

# Lista o destino como "tamanho;nome", uma linha por arquivo.
list_remote() {
  REMOTE_LISTING=$(rclone --config "$RCLONE_CONFIG_FILE" lsf --files-only --format sp --separator ';' "$REMOTE/" 2>>"$RUN_LOG") \
    || fail 'não foi possível listar o destino'
}

remote_size_of() {
  local name=$1 line
  while IFS= read -r line; do
    if [[ ${line#*;} == "$name" ]]; then
      printf '%s' "${line%%;*}"
      return 0
    fi
  done <<<"$REMOTE_LISTING"
  return 0
}

# Envia todo arquivo cifrado local que ainda não está no destino (o de hoje e os que ficaram
# pendentes de uma falha anterior) e confere o tamanho de cada um. Só arquivos .dump.age saem.
upload_pending() {
  local file name size remote_size pending=()
  STEP=listar
  list_remote
  for file in "$LOCAL_DIR"/soprei-*.dump.age; do
    [[ -f $file ]] || continue
    name=${file##*/}
    size=$(file_size "$file")
    remote_size=$(remote_size_of "$name")
    if [[ -z $remote_size ]]; then
      pending+=("$file")
    elif [[ $remote_size != "$size" ]]; then
      STEP=conferir
      fail "o arquivo $name existe no destino com outro tamanho"
    fi
  done

  if [[ $DRY_RUN == true ]]; then
    log "simulação: ${#pending[@]} arquivo(s) cifrado(s) local(is) ainda não estão no destino"
    return 0
  fi

  STEP=enviar
  for file in "${pending[@]}"; do
    name=${file##*/}
    case "$name" in *.dump.age) ;; *) fail 'tentativa de enviar arquivo não cifrado' ;; esac
    log "enviando $name"
    rclone --config "$RCLONE_CONFIG_FILE" copyto "$file" "$REMOTE/$name" >>"$RUN_LOG" 2>&1 \
      || fail "o envio de $name falhou"
  done

  STEP=conferir
  list_remote
  for file in "${pending[@]}"; do
    name=${file##*/}
    size=$(file_size "$file")
    remote_size=$(remote_size_of "$name")
    [[ $remote_size == "$size" ]] || fail "o arquivo $name não está no destino com o tamanho esperado"
  done
}

prune_local() {
  STEP=expirar
  if [[ $DRY_RUN == true ]]; then
    log "simulação: cópias locais com mais de $LOCAL_KEEP_DAYS dia(s) seriam apagadas"
    return 0
  fi
  find "$LOCAL_DIR" -maxdepth 1 -type f \( -name 'soprei-*.dump' -o -name 'soprei-*.dump.age' \) \
    -mtime "+$LOCAL_KEEP_DAYS" -delete 2>>"$RUN_LOG" || fail 'não foi possível apagar as cópias locais antigas'
}

# Um GET sem corpo e sem parâmetro: nenhum dado sai. Falha do aviso não desfaz o backup.
ping_success() {
  [[ -n $PING_URL ]] || return 0
  STEP=avisar
  if curl -fsS -m 10 --retry 2 -o /dev/null "$PING_URL" >>"$RUN_LOG" 2>&1; then
    PING_RESULT=ok
  else
    PING_RESULT=failed
    log 'aviso: o backup terminou bem, mas o sinal de vida não foi entregue' >&2
  fi
}

main() {
  parse_args "$@"
  load_conf
  require_tools

  if [[ $DRY_RUN == true ]]; then
    RUN_LOG=/dev/null
    log "simulação: banco $DB_NAME, cópias locais em $LOCAL_DIR por $LOCAL_KEEP_DAYS dia(s), destino configurado"
    if [[ -d $LOCAL_DIR ]]; then upload_pending; else log 'simulação: a pasta local ainda não existe'; fi
    prune_local
    log 'simulação concluída: nada foi gerado, enviado nem apagado'
    exit 0
  fi

  acquire_lock
  prepare_dirs
  local stamp
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  dump_database "$stamp"
  encrypt_dump "$stamp"
  upload_pending
  prune_local
  ping_success
  STEP=concluido
  write_status ok
  log "backup concluído: $NEW_FILE ($NEW_SIZE bytes)"
}

main "$@"
