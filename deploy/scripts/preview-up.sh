#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

node deploy/scripts/secret-init.mjs
docker compose \
  --env-file deploy/env/internal.env \
  --env-file deploy/env/preview.env.example \
  -f deploy/compose.yaml config --quiet
docker compose \
  --env-file deploy/env/internal.env \
  --env-file deploy/env/preview.env.example \
  -f deploy/compose.yaml up --detach --no-build --wait --wait-timeout 420
printf '%s\n' 'MK Docker 预演入口：http://127.0.0.1:7410'
