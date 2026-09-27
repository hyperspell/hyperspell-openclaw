#!/bin/bash
# Local dist-swap deploy (CLAUDE.local.md recipe) for the scale-report branch.
# Run by the operator via `!` — mutates the live plugin install, so it is not
# agent-runnable by design. Swaps dist AND openclaw.plugin.json (this branch
# adds ranking schema keys; the strict manifest must move with the code).
set -euo pipefail

TAG="scale-report-$(date +%Y%m%d%H%M)"
R="$HOME/dev/hyperspell-openclaw"
P="$HOME/.openclaw/npm/projects/hyperspell-openclaw-hyperspell-4b313d96b8__openclaw-generation__g-ea604da09804d68a/node_modules/@hyperspell/openclaw-hyperspell"

[ -d "$R/dist" ] || { echo "no built dist in $R — run npm run build first"; exit 1; }
[ -d "$P/dist" ] || { echo "live plugin dist not found at $P"; exit 1; }

echo "== backup (mv) =="
mv "$P/dist" "$P/dist.bak-$TAG"
cp "$P/openclaw.plugin.json" "$P/openclaw.plugin.json.bak-$TAG"

echo "== install new dist + manifest =="
cp -R "$R/dist" "$P/dist"
cp "$R/openclaw.plugin.json" "$P/openclaw.plugin.json"

echo "== smoke-load =="
( cd "$P" && node --input-type=module -e "await import('./dist/index.js'); console.log('smoke-load OK')" )

echo "== gateway restart =="
node "$HOME/dev/openclaw/dist/index.js" gateway restart

echo
echo "Deployed with tag $TAG. Rollback:"
echo "  rm -rf '$P/dist' && mv '$P/dist.bak-$TAG' '$P/dist' && mv '$P/openclaw.plugin.json.bak-$TAG' '$P/openclaw.plugin.json' && openclaw gateway restart"
