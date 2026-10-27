#!/usr/bin/env bash
# The build: src/ into a fresh dist/. Every source is a handwritten .d.ts, which tsc never emits,
# so src/ is copied as written.
# From spike-html-packages-sdk (9d10ca6): scripts/build.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf dist
cp -R src dist
