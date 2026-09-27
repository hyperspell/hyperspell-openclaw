# Local verify recipe (David's machine)

This repo's live test target is **Alinea**, David's personal OpenClaw agent, running locally:

- Gateway: dev checkout at `node /Users/davidszarzynski/dev/openclaw/dist/index.js gateway ...`, supervised by launchd (`ai.openclaw.gateway`). Restart with `openclaw gateway restart` or the dev-checkout entrypoint (`node ~/dev/openclaw/dist/index.js gateway restart`) if the `openclaw` CLI binary has vanished.
- Active plugin install (moved as of Aug 2026 — OpenClaw now uses per-plugin project dirs): `~/.openclaw/npm/projects/hyperspell-openclaw-hyperspell-*/node_modules/@hyperspell/openclaw-hyperspell/`. Confirm the exact dir with `node ~/dev/openclaw/dist/index.js plugins list`. Config: `~/.openclaw/openclaw.json`.

## Deploy a local build for verification (working method)

1. `npm run build` in this repo.
2. Back up the active dist, then replace it (PLUGIN_DIR = the projects-dir path above):
   ```
   cp -R "$PLUGIN_DIR/dist" "$PLUGIN_DIR/dist.bak-<tag>"
   rm -rf "$PLUGIN_DIR/dist"
   cp -R dist "$PLUGIN_DIR/dist"
   ```
   (Runtime deps — hyperspell, typebox, clack — are already hoisted at `~/.openclaw/npm/node_modules/`; `openclaw` is a type-only import erased at build time, so no peer link is needed.)
3. Smoke-load before restarting the gateway: `node --input-type=module -e "await import('./dist/index.js')"` from the active plugin dir (catches import-time crashes early).
4. `node ~/dev/openclaw/dist/index.js gateway restart`.
5. Verify the deploy landed: `plugins list` shows the bumped version, and gateway logs show `hyperspell: connected` (not a config/registration error).
6. **Actually exercise the change** — start or continue a real session with Alinea and trigger the specific surface you changed (a hook firing, a slash command, a tool call, a config gate) and confirm the real behavior, not just that the process came up clean.
7. Revert when done testing: restore the backed-up `dist/` (this is a local-only deploy — don't `npm publish` from this loop, and the repo/npm registry version stays untouched).

## Guardrails (see `feedback_alinea_is_production` memory)

Alinea is David's personal, currently-in-use agent, not a disposable test fixture — protect her from breakage, but she isn't customer-prod either: reads are free, no need for release ceremony. Before treating something as "broken in Alinea," confirm the relevant feature is actually enabled in her config (`~/.openclaw/openclaw.json`) — most features here are opt-in.

## Known footgun

`openclaw plugins update <spec>` has previously wrecked the npm-managed prefix (reset `package.json`, pruned the `openclaw` peer link and the whole `.bin/`). Don't use `plugins update` for this loop — use the manual dist-swap above, or `plugins install --force --dangerously-force-unsafe-install` from the dev-checkout CLI if a full reinstall is actually needed.
