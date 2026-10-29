#!/bin/sh
# Build Slowboard.mcpb, the Claude Desktop extension: the manifest and this one
# file, zipped. Run after changing index.mjs, and commit the result, so it can be
# double-clicked from a fresh clone.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/server"
cp "$here/manifest.json" "$work/manifest.json"
cp "$root/index.mjs" "$work/server/index.mjs"
rm -f "$root/Slowboard.mcpb"
(cd "$work" && zip -q -r "$root/Slowboard.mcpb" manifest.json server)
echo "Built $root/Slowboard.mcpb"
