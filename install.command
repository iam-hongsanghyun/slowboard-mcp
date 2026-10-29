#!/bin/bash
# Connect Claude to Slowboard: double-click this file.
#
# It asks for your key (Settings > You > API keys on the board), checks it with
# the board, and adds one MCP server, "slowboard", to Claude Code for every
# project. One key reaches every organisation you belong to, so this is done
# once. It then offers to remove older per-organisation board servers, and to
# add Slowboard to Claude Desktop as well.
#
# The key goes only into Claude's own configuration. It is never printed, and is
# passed to the board on standard input rather than on a command line.

set -u
cd "$(dirname "$0")" || exit 1
DIR=$(pwd)
URL="${BOARD_API_URL:-https://slow-board.vercel.app}"

# A dialog; the message is passed as an argument, never spliced into AppleScript.
alert() {
  osascript - "$1" >/dev/null 2>&1 <<'APPLESCRIPT'
on run argv
  display alert "Slowboard" message (item 1 of argv)
end run
APPLESCRIPT
}
ask() {
  osascript - "$1" 2>/dev/null <<'APPLESCRIPT'
on run argv
  try
    display dialog (item 1 of argv) with title "Slowboard" buttons {"No", "Yes"} default button "Yes"
    return "yes"
  on error
    return "no"
  end try
end run
APPLESCRIPT
}
fail() {
  echo
  echo "$1"
  alert "$1"
  exit 1
}

# Node 18 or later, wherever it was installed.
NODE=$(command -v node || true)
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -z "$NODE" ] && [ -x "$candidate" ] && NODE=$candidate
done
if [ -z "$NODE" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  NODE=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)
fi
[ -n "$NODE" ] || fail "Node is needed and was not found. Install it from https://nodejs.org, then double-click this file again."
"$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' \
  || fail "Node 18 or later is needed; this computer has $("$NODE" --version). Update it from https://nodejs.org."

KEY=$(osascript 2>/dev/null <<'APPLESCRIPT'
try
  set r to display dialog "Paste your Slowboard key. Make one on the board under Settings > You > API keys -- allow writing if Claude should post, edit and draw." default answer "" with hidden answer with title "Slowboard" buttons {"Cancel", "Connect"} default button "Connect"
  return text returned of r
on error
  return ""
end try
APPLESCRIPT
)
KEY=$(printf '%s' "$KEY" | tr -d '[:space:]')
[ -n "$KEY" ] || { echo "Cancelled."; exit 0; }
[[ "$KEY" =~ ^cmk_[0-9a-fA-F]{64}$ ]] || fail "That is not a Slowboard key: a key starts with cmk_ and is 68 characters long."

echo "Checking the key with $URL ..."
ANSWER=$(printf 'Authorization: Bearer %s\n' "$KEY" | curl -sS -m 20 -H @- "$URL/api/v1/organisations" 2>&1) \
  || fail "Could not reach $URL: $ANSWER"
ORGS=$(printf '%s' "$ANSWER" | "$NODE" -e '
  let d = ""
  process.stdin.on("data", (c) => (d += c)).on("end", () => {
    let j
    try { j = JSON.parse(d) } catch { console.log("The board gave an answer that was not understood."); process.exit(2) }
    if (j.error) { console.log(j.error); process.exit(2) }
    console.log((j.organisations || []).map((o) => o.name).join(", ") || "none yet")
  })') || fail "The board did not accept the key: $ORGS"
echo "The key reaches: $ORGS"

# ── Claude Code ─────────────────────────────────────────────────────────────
CLAUDE=$(command -v claude || true)
for candidate in "$HOME/.claude/local/claude" "$HOME/.local/bin/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
  [ -z "$CLAUDE" ] && [ -x "$candidate" ] && CLAUDE=$candidate
done
if [ -n "$CLAUDE" ]; then
  "$CLAUDE" mcp remove slowboard -s user >/dev/null 2>&1
  ENV_ARGS=(-e "BOARD_API_KEY=$KEY")
  [ "$URL" != "https://slow-board.vercel.app" ] && ENV_ARGS+=(-e "BOARD_API_URL=$URL")
  # The name first: -e takes several values, and would take the name as one.
  "$CLAUDE" mcp add slowboard -s user "${ENV_ARGS[@]}" -- "$NODE" "$DIR/index.mjs" >/dev/null \
    || fail "Claude Code did not take the server. Run: claude mcp add -s user slowboard -- node $DIR/index.mjs"
  echo "Claude Code: added \"slowboard\" for every project."
  CODE=yes
else
  echo "Claude Code is not installed here; skipped."
  CODE=no
fi

# ── older per-organisation servers ──────────────────────────────────────────
# Any other server running this same file was made for one organisation's key.
DESKTOP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
OLD=$("$NODE" -e '
  const fs = require("fs")
  const [code, desktop, file] = process.argv.slice(1)
  const found = []
  const scan = (where, servers) => {
    for (const [name, s] of Object.entries(servers || {})) {
      if (name !== "slowboard" && (s.args || []).some((a) => String(a).endsWith(file))) found.push(`${where}:${name}`)
    }
  }
  try { scan("code", JSON.parse(fs.readFileSync(code, "utf8")).mcpServers) } catch {}
  try { scan("desktop", JSON.parse(fs.readFileSync(desktop, "utf8")).mcpServers) } catch {}
  console.log(found.join(" "))
' "$HOME/.claude.json" "$DESKTOP_CONFIG" "slowboard-mcp/index.mjs")
if [ -n "$OLD" ]; then
  NAMES=$(printf '%s' "$OLD" | tr ' ' '\n' | sed 's/^code:/Claude Code: /; s/^desktop:/Claude Desktop: /' | paste -sd ',' - | sed 's/,/, /g')
  if [ "$(ask "These older board servers were each made for one organisation's key: $NAMES. The new one covers every organisation. Remove the old ones?")" = "yes" ]; then
    for entry in $OLD; do
      name=${entry#*:}
      case "$entry" in
        code:*) [ -n "$CLAUDE" ] && "$CLAUDE" mcp remove "$name" -s user >/dev/null 2>&1 && echo "Claude Code: removed $name." ;;
      esac
    done
    if printf '%s' "$OLD" | grep -q 'desktop:'; then
      cp "$DESKTOP_CONFIG" "$DESKTOP_CONFIG.before-slowboard" && "$NODE" -e '
        const fs = require("fs")
        const [path, file] = process.argv.slice(1)
        const c = JSON.parse(fs.readFileSync(path, "utf8"))
        for (const [name, s] of Object.entries(c.mcpServers || {})) {
          if (name !== "slowboard" && (s.args || []).some((a) => String(a).endsWith(file))) delete c.mcpServers[name]
        }
        fs.writeFileSync(path, JSON.stringify(c, null, 2) + "\n")
      ' "$DESKTOP_CONFIG" "slowboard-mcp/index.mjs" \
        && echo "Claude Desktop: removed the old ones (the file before is kept beside it, .before-slowboard)."
    fi
  fi
fi

# ── Claude Desktop ──────────────────────────────────────────────────────────
if [ -d "/Applications/Claude.app" ] || [ -d "$HOME/Applications/Claude.app" ]; then
  if [ "$(ask "Add Slowboard to Claude Desktop too? Desktop opens its own install window and asks for the key once more.")" = "yes" ]; then
    open "$DIR/Slowboard.mcpb"
  fi
fi

echo
if [ "$CODE" = yes ]; then
  echo "Done. Start a new Claude Code session (or run /mcp) and ask, for example:"
  echo "  \"What moved on the board this week?\""
fi
alert "Slowboard is connected. Ask Claude about your boards in a new session."
