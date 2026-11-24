#!/usr/bin/env bash
# Soprei, spec 043: teste de restauração de um backup cifrado. Passo a passo em docs/ops/backup.md.
#
#   soprei-restore-check [--as-current-user] <arquivo.dump.age> <arquivo-de-identidade-do-age>
#
# Decifra o arquivo, restaura num banco temporário de nome FIXO (soprei_restore_check), confere que
# as tabelas principais existem e têm linhas, imprime só contagens e apaga o banco temporário e o
# arquivo decifrado, também quando falha. Nunca toca o banco de produção nem imprime conteúdo.
#
# A chave privada (arquivo de identidade) não mora no servidor: rode numa máquina que não seja a
# produção, ou leve a chave só pelo tempo do teste. Sem --as-current-user os comandos do PostgreSQL
# rodam como o usuário postgres (runuser, exige root); com a opção, rodam como o usuário atual, com
# as variáveis PG* do ambiente (máquina sem o usuário de sistema postgres).
#
# Códigos de saída: 0 restauração conferida; 1 recusado antes de começar; 2 a restauração falhou.
set -Eeuo pipefail
umask 077
export LC_ALL=C
IFS=$' \t\n'

readonly CHECK_DB=soprei_restore_check
readonly TABLES='companies accounts memberships conversations messages'
readonly REQUIRED_NON_EMPTY='companies accounts'

RUNUSER=${SOPREI_BACKUP_RUNUSER:-/usr/sbin/runuser}
AS_CURRENT_USER=false
ENCRYPTED=''
IDENTITY=''
WORK_DIR=''
CREATED_DB=false

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die_usage() {
  log "recusado: $*" >&2
  exit 1
}

# Comando do PostgreSQL como o usuário postgres (padrão) ou como o usuário atual.
pg() {
  if [[ $AS_CURRENT_USER == true ]]; then
    "$@"
  else
    "$RUNUSER" -u postgres -- "$@"
  fi
}

# Chamada só pelo `trap ... EXIT` do main (o shellcheck não enxerga essa chamada).
# shellcheck disable=SC2329
cleanup() {
  if [[ $CREATED_DB == true ]]; then
    pg dropdb --if-exists "$CHECK_DB" >/dev/null 2>&1 || log "ATENÇÃO: apague à mão o banco $CHECK_DB" >&2
  fi
  if [[ -n $WORK_DIR && -d $WORK_DIR ]]; then
    rm -rf "$WORK_DIR"
  fi
}

fail() {
  log "FALHOU: $*" >&2
  exit 2
}

parse_args() {
  local positional=()
  while (($# > 0)); do
    case "$1" in
      --as-current-user) AS_CURRENT_USER=true ;;
      -*) die_usage 'opção desconhecida' ;;
      *) positional+=("$1") ;;
    esac
    shift
  done
  ((${#positional[@]} == 2)) || die_usage 'uso: soprei-restore-check [--as-current-user] <arquivo.dump.age> <identidade>'
  ENCRYPTED=${positional[0]}
  IDENTITY=${positional[1]}
  [[ $ENCRYPTED == *.dump.age && -f $ENCRYPTED && -r $ENCRYPTED ]] || die_usage 'o primeiro argumento precisa ser um arquivo .dump.age legível'
  [[ -f $IDENTITY && -r $IDENTITY ]] || die_usage 'arquivo de identidade ausente ou ilegível'
}

require_tools() {
  local tool
  for tool in age mktemp; do
    command -v "$tool" >/dev/null 2>&1 || die_usage "$tool não encontrado"
  done
  if [[ $AS_CURRENT_USER == false ]]; then
    [[ -x $RUNUSER ]] || die_usage 'runuser não encontrado (use --as-current-user fora do servidor)'
  fi
}

refuse_if_database_exists() {
  local found
  found=$(pg psql -X -At -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$CHECK_DB'") \
    || die_usage 'não foi possível consultar o PostgreSQL'
  [[ -z $found ]] || die_usage "o banco $CHECK_DB já existe: confira e apague à mão antes de repetir"
}

restore() {
  local plain="$WORK_DIR/restore.dump"
  log 'decifrando o backup'
  age -d -i "$IDENTITY" -o "$plain" "$ENCRYPTED" >/dev/null 2>&1 || fail 'o age não decifrou o arquivo (chave errada ou arquivo corrompido)'
  [[ -s $plain ]] || fail 'o arquivo decifrado está vazio'
  log "criando o banco temporário $CHECK_DB"
  pg createdb "$CHECK_DB" >/dev/null 2>&1 || fail 'não foi possível criar o banco temporário'
  CREATED_DB=true
  log 'restaurando (pode levar alguns minutos)'
  # O dump entra pela entrada padrão: o usuário postgres não lê a pasta de trabalho (modo 700).
  pg pg_restore --no-owner --no-privileges --exit-on-error -d "$CHECK_DB" <"$plain" >/dev/null 2>&1 \
    || fail 'o pg_restore terminou com erro'
}

check_counts() {
  local table count
  for table in $TABLES; do
    count=$(pg psql -X -At -d "$CHECK_DB" -c "SELECT count(*) FROM $table") \
      || fail "a tabela $table não existe no backup restaurado"
    [[ $count =~ ^[0-9]+$ ]] || fail "contagem inválida na tabela $table"
    log "tabela $table: $count linha(s)"
    case " $REQUIRED_NON_EMPTY " in
      *" $table "*) ((count > 0)) || fail "a tabela $table veio vazia" ;;
    esac
  done
}

main() {
  parse_args "$@"
  require_tools
  refuse_if_database_exists
  trap cleanup EXIT
  WORK_DIR=$(mktemp -d)
  local started=$SECONDS
  restore
  check_counts
  log "restauração conferida em $((SECONDS - started)) s; apagando o banco temporário e o arquivo decifrado"
}

main "$@"
