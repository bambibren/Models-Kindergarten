#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

docker compose --env-file deploy/env/preview.env.example -f deploy/compose.yaml down
