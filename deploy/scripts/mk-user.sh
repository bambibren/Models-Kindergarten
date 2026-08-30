#!/bin/sh
set -eu

release_dir=/srv/mk/current
compose="docker compose --env-file release.env -f compose.yaml"
command_name=${1:-}
username=${2:-}

case "$command_name" in
  list) ;;
  add|reset-password|disable|enable|delete)
    [ -n "$username" ] || { echo "用法：sudo mk-user $command_name <用户名>" >&2; exit 1; }
    ;;
  *)
    echo "用法：sudo mk-user {add|list|reset-password|disable|enable|delete} [用户名]" >&2
    exit 1
    ;;
esac

cd "$release_dir"
export ONLYOFFICE_JWT_SECRET
export ONLYOFFICE_PREVIEW_SECRET
ONLYOFFICE_JWT_SECRET=$(cat /srv/mk/secrets/onlyoffice_jwt_secret)
ONLYOFFICE_PREVIEW_SECRET=$(cat /srv/mk/secrets/onlyoffice_preview_secret)
restart_app() {
  $compose start mk-app >/dev/null
}
$compose stop mk-app >/dev/null
trap restart_app EXIT INT TERM

run_cli() {
  $compose run --rm -T --no-deps --entrypoint node mk-app \
    /app/apps/remote/dist/auth-user-cli.js "$command_name" "$@"
}

case "$command_name" in
  add|reset-password)
    printf "请输入密码：" >&2
    stty -echo
    IFS= read -r password
    printf "\n请再次输入密码：" >&2
    IFS= read -r repeated
    stty echo
    printf "\n" >&2
    printf '%s\n%s\n' "$password" "$repeated" | run_cli "$username"
    ;;
  delete)
    printf "警告：删除账号会永久删除该账号的会话、模型、Agent、实验、产物、文件和 API Key。\n" >&2
    printf "请输入“确认删除账号 %s”：" "$username" >&2
    IFS= read -r confirmation
    printf '%s\n' "$confirmation" | run_cli "$username"
    ;;
  list) run_cli ;;
  *) run_cli "$username" ;;
esac

trap - EXIT INT TERM
restart_app
