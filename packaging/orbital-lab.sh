#!/usr/bin/env bash
# Linux/macOS launcher for the Orbital Lab release package.
set -euo pipefail
root=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
command -v node >/dev/null 2>&1 || {
  printf 'Node.js is required. Install Node.js 22.12+ (22.x) or 24+ and try again.\n' >&2
  exit 1
}
exec node "$root/launcher.mjs" "$@"
