#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
: "${PRODUCTION_JAR:?Set PRODUCTION_JAR to the verified production JAR path}"
EXPECTED_SHA=0c9d3e6de84b4ecf434b926a011f343dbd3bd008aad62e9474118c76b00778f1
ACTUAL_SHA=$(sha256sum "$PRODUCTION_JAR" | cut -d' ' -f1)
if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
  printf 'production JAR hash mismatch\n' >&2
  exit 1
fi

rm -rf "$ROOT/build"
mkdir -p "$ROOT/build/lib" "$ROOT/build/production-classes" "$ROOT/build/classes/main" "$ROOT/build/classes/test"
unzip -q -j "$PRODUCTION_JAR" 'BOOT-INF/lib/*.jar' -d "$ROOT/build/lib"
(
  cd "$ROOT/build/production-classes"
  jar xf "$PRODUCTION_JAR" BOOT-INF/classes
)
printf 'offline_classpath_prepared=true\n'
