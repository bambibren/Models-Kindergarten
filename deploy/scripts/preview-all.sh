#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

sh deploy/scripts/preview-build.sh
sh deploy/scripts/preview-up.sh
node deploy/scripts/preview-smoke.mjs
