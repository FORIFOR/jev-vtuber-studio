#!/bin/sh
cd "$(dirname "$0")" || exit 1

# If node is not in current PATH (e.g. launched from macOS Finder), search common install paths
if ! command -v node >/dev/null 2>&1; then
  for dir in /opt/homebrew/bin /usr/local/bin /opt/local/bin "$HOME"/.local/share/mise/shims "$HOME"/.nodenv/shims "$HOME"/.local/share/fnm/current/bin; do
    if [ -x "$dir/node" ]; then
      PATH="$dir:$PATH"
      break
    fi
  done
fi
if ! command -v node >/dev/null 2>&1; then
  for node_bin in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$node_bin" ]; then
      PATH="$(dirname "$node_bin"):$PATH"
      break
    fi
  done
fi

if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js 22.12+ is required. Install Node.js, then reopen this file.\n'
  exit 1
fi
exec node scripts/cli.mjs start

