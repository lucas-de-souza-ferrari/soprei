#!/usr/bin/env bash
# Soprei, spec 037 (E3): programa de entrada do deploy automático. MODELO versionado: o que roda é a
# cópia instalada pelo dono em /usr/local/sbin/soprei-deploy-entry (root, 755), nunca este arquivo do
# repositório (um merge não troca o porteiro). Passos de instalação em docs/ops/deploy.md.
#
# Duas fases no mesmo arquivo:
#   1. De fora (sem argumentos; roda como soprei-deploy, forçada pelo sshd com command= e ForceCommand):
#      confere SSH_ORIGINAL_COMMAND, que só pode ser exatamente
#        --env production --ref <40 hexadecimais minúsculos>
#        --env production --ref <40 hexadecimais minúsculos> --dry-run
#      e chama `sudo -n` para a fase de dentro. Qualquer outro texto sai com 64, sem ecoá-lo.
#   2. De dentro (--from-ssh <sha> <deploy|dry-run>; roda como root pelo sudo restrito): confere tudo
#      de novo, lê /etc/soprei-deploy/entry.conf como texto (nunca por source) e roda o deploy.sh com
#      --auto e o ambiente limpo (env -i): nenhuma variável vinda do SSH chega ao script.
#
# Códigos de saída: os do deploy.sh (0, 1, 2, 3); 64 = pedido fora do formato; 1 = desligado
# (ENABLED=false) ou entry.conf inválido.
#
# Os caminhos ficam nas constantes abaixo (o teste copia o arquivo e troca só essas linhas por dublês).
# Nenhuma variável de ambiente muda o comportamento do programa instalado.
set -euo pipefail
umask 077
export LC_ALL=C
IFS=$' \t\n'

readonly SUDO=/usr/bin/sudo
readonly SELF=/usr/local/sbin/soprei-deploy-entry
readonly DEPLOY=/var/www/soprei/deploy/deploy.sh
readonly CONF=/etc/soprei-deploy/entry.conf
readonly LOGGER=/usr/bin/logger
readonly REQUIRE_ROOT=true
# Dono exigido do entry.conf, do deploy.sh e da pasta deploy/ (root), e se a conferência vale.
readonly TRUSTED_UID=0
readonly CHECK_OWNERSHIP=true

readonly REQUEST_RE='^--env production --ref ([0-9a-f]{40})( --dry-run)?$'
readonly SHA_RE='^[0-9a-f]{40}$'
readonly MAX_REQUEST_LENGTH=80

# Configuração lida de entry.conf.
ENABLED=''
ALLOW_UNSTAGED=false
MIGRATIONS=auto

# Registro no syslog (melhor esforço): só o resultado e, se aceito, o SHA curto. Nunca o texto recusado.
note() {
  "$LOGGER" -t soprei-deploy-entry -- "$1" 2>/dev/null || true
}

refuse_request() {
  note 'pedido recusado (fora do formato)'
  printf '%s\n' 'soprei-deploy-entry: pedido recusado (fora do formato aceito)' >&2
  exit 64
}

refuse_config() {
  note "recusado: $1"
  printf 'soprei-deploy-entry: %s\n' "$1" >&2
  exit 1
}

outer_phase() {
  local request=${SSH_ORIGINAL_COMMAND-}
  local sha mode=deploy
  ((${#request} > 0 && ${#request} <= MAX_REQUEST_LENGTH)) || refuse_request
  [[ $request =~ $REQUEST_RE ]] || refuse_request
  sha=${BASH_REMATCH[1]}
  if [[ -n ${BASH_REMATCH[2]} ]]; then
    mode=dry-run
  fi
  note "pedido aceito: sha=${sha:0:7} modo=$mode"
  exec "$SUDO" -n "$SELF" --from-ssh "$sha" "$mode"
}

# Lê entry.conf como texto: só as chaves e os valores conhecidos; qualquer outra coisa recusa sem
# executar nada (o valor nunca vai a um shell).
read_conf() {
  local line key value owner_mode
  [[ -f $CONF && -r $CONF ]] || refuse_config 'entry.conf ausente ou ilegível'
  if [[ $CHECK_OWNERSHIP == true ]]; then
    owner_mode=$(stat -c '%u %a' -- "$CONF") || refuse_config 'não consegui conferir o dono do entry.conf'
    [[ $owner_mode == "$TRUSTED_UID 600" ]] || refuse_config 'entry.conf precisa ser do root com modo 600'
  fi
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    case "$line" in '' | '#'*) continue ;; esac
    [[ $line == *=* ]] || refuse_config 'entry.conf inválido (linha sem "=")'
    key=${line%%=*}
    value=${line#*=}
    case "$key" in
      ENABLED)
        [[ $value == true || $value == false ]] || refuse_config 'entry.conf inválido (ENABLED só aceita true ou false)'
        ENABLED=$value
        ;;
      ALLOW_UNSTAGED)
        [[ $value == true || $value == false ]] || refuse_config 'entry.conf inválido (ALLOW_UNSTAGED só aceita true ou false)'
        ALLOW_UNSTAGED=$value
        ;;
      MIGRATIONS)
        # D16 (recomendação aprovada): a migration aditiva segue pelo automático; a destrutiva é
        # recusada pelo deploy.sh, porque --allow-breaking nunca é passado. "manual" (D16 alternativa)
        # não foi implementado.
        [[ $value == auto ]] || refuse_config 'entry.conf inválido (MIGRATIONS só aceita auto)'
        MIGRATIONS=$value
        ;;
      *) refuse_config 'entry.conf inválido (chave desconhecida)' ;;
    esac
  done <"$CONF"
  [[ -n $ENABLED ]] || refuse_config 'entry.conf sem ENABLED'
}

# O deploy.sh que roda como root e a pasta deploy/ que o contém precisam ser do root e sem escrita para
# grupo e outros: senão quem escreve neles escolhe o que o root executa.
check_deploy_owner() {
  [[ $CHECK_OWNERSHIP == true ]] || return 0
  local path owner mode
  for path in "$DEPLOY" "${DEPLOY%/*}"; do
    read -r owner mode < <(stat -L -c '%u %a' -- "$path" 2>/dev/null) || refuse_config 'não consegui conferir o dono do deploy.sh'
    [[ $owner == "$TRUSTED_UID" && $mode =~ ^[0-7]{3,4}$ ]] || refuse_config 'o deploy.sh e a pasta deploy/ precisam ser do root'
    (( (8#$mode & 8#022) == 0 )) || refuse_config 'o deploy.sh e a pasta deploy/ não podem ter escrita para grupo e outros'
  done
}

inner_phase() {
  (($# == 3)) || refuse_request
  [[ $1 == --from-ssh ]] || refuse_request
  [[ $2 =~ $SHA_RE ]] || refuse_request
  [[ $3 == deploy || $3 == dry-run ]] || refuse_request
  local sha=$2 mode=$3
  if [[ $REQUIRE_ROOT == true && $EUID -ne 0 ]]; then
    refuse_config 'a fase de dentro só roda como root (pelo sudo)'
  fi
  read_conf
  if [[ $ENABLED != true ]]; then
    refuse_config 'deploy automático desligado no servidor (ENABLED=false em entry.conf); nada foi feito'
  fi
  local -a args=(--env production --ref "$sha" --auto)
  if [[ $mode == dry-run ]]; then
    args+=(--dry-run)
  fi
  if [[ $ALLOW_UNSTAGED == true ]]; then
    args+=(--allow-unstaged)
  fi
  check_deploy_owner
  note "deploy iniciado: sha=${sha:0:7} modo=$mode migrations=$MIGRATIONS"
  cd /
  exec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root LC_ALL=C "$DEPLOY" "${args[@]}"
}

main() {
  if (($# == 0)); then
    outer_phase
  fi
  inner_phase "$@"
}

main "$@"
