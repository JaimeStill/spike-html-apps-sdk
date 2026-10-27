#!/usr/bin/env bash
# Fails naming mise run install when a tool a task needs is missing: the node_modules tooling.
# From spike-html-packages-sdk (9d10ca6): scripts/preflight.sh.
set -euo pipefail

fail() {
  echo "preflight: $1 isn't installed; run mise run install" >&2
  exit 1
}

for bin in eslint prettier; do
  [[ -x node_modules/.bin/$bin ]] || fail "$bin (devDependencies)"
done
