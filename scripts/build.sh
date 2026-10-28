#!/usr/bin/env bash
# The build: src/ into a fresh dist/. tsc emits each module's .js and .d.ts, and a handwritten .d.ts,
# which tsc never emits, is copied beside them as written.
# Adapted from spike-html-packages-sdk (9d10ca6): scripts/build.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf dist
tsc -p .
(cd src && find . -type f -name '*.d.ts' -print0 | xargs -0 -r cp --parents -t ../dist)
