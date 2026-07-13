# Implementation guide — #67: Make external note directories (e.g. `notes/brainstem/`) syncable and searchable, with provenance tagging

## Problem

`syncMemoriesConfig.watchPaths` defaults to `[]` (`config.ts:565-567`), so the sync pipeline only ever sees `<workspace>/memory/`. A nightly consolidator writing `notes/brainstem/YYYY-MM-DD.md` under the workspace root is invisible to both the startup bulk sync (`syncAllFilesSectionized` → `getSyncableFiles`) and the live watcher (`startFileWatcher` / `buildFileSyncHandler`), so `hyperspell_search` can never surface that content. Additionally, even when a user *does* configure `watchPaths`, everything synced is tagged identically (`openclaw_source: "memory_sync_section"`, `sync/markdown.ts:543`) — there is no way to tell a curated `MEMORY.md` fragment from a machine-generated brainstem daily at retrieval time.

## Scope reconciliation (2026-07-12, implemented against main @ 0.19.0)

Verified against `origin/main` (release 0.19.0): `index.ts:244-245` registers `buildFileSyncHandler` on the **phantom `file_changed` hook** (OpenClaw never emits it — live watch is inert; startup bulk sync at `index.ts:274` works), and there is **no `startFileWatcher`** on main. The WIP-only pieces below are therefore **deferred as WIP-gated follow-ups**, to land with (or after) the maintainer's watcher WIP:

- **§4/§5 `startFileWatcher` + the `fs.watch` rewrite** — does not exist on main; nothing to wire.
- **§5 `buildFileSyncHandler` `workspaceDir` param refactor** — only needed for the fs.watch-based tests; handler keeps calling `getWorkspaceDir()` internally.
- **`hooks/memory-sync.test.ts`** — its fixtures assume the `workspaceDir` param + real `fs.watch`; not added (and not added to `package.json`'s test list).

Everything WIP-independent **was implemented**: §1 (`WatchPathEntry` config), §2 (shared resolvers), §3 (`openclaw_sync_source` threading incl. `syncAllMemoryFiles` tagged `"memory"`), §4's non-watcher parts (`resolveWatchPath`/`resolveSyncSource` in the existing handler, plus the `isIgnoredPath` generalization — that asymmetry exists on main's `hooks/memory-sync.ts`, not only in WIP), §6 README, and the `config.test.ts`/`sync/markdown.test.ts` tests. No `index.ts` change was needed: types flow through the existing `syncMemoriesOnStartup` call, and there is no watcher call to map entries for.

**⚠️ Verify against `origin/main` before implementing, not the local working tree.** This guide's `index.ts:295-308` wiring citation (§5 below) and its `hooks/memory-sync.test.ts` fixtures describe the maintainer's uncommitted local WIP — on `origin/main`, `index.ts` does not yet wire `syncMemoriesOnStartup`/`startFileWatcher`, and `hooks/memory-sync.test.ts` is untracked (not in `package.json`'s test list). Confirm the actual current `index.ts` memory-sync wiring and test-file state before implementing §5, rather than assuming this snapshot is what's on the remote.

## Design decision: do NOT widen the default watch scope

Keep the default `watchPaths: []`. Widening the default (e.g. auto-watching `notes/`) would silently start ingesting arbitrary workspace content on upgrade for every existing install — an ingest-volume, cost, and privacy surprise. This plugin's convention is default-off for behavior-changing features (see the `hotBuffer.enabled` default comment at `config.ts:532-534`). The fix is therefore:

1. **Documentation** — README gains a worked `watchPaths` example for the external-daily-notes setup.
2. **Provenance** — `watchPaths` entries gain an optional per-path `source` label that is stamped into memory metadata at sync time, so brainstem dailies are distinguishable from `memory/` content.

## Provenance key: add `openclaw_sync_source`, do not overload `openclaw_source`

`openclaw_source` encodes *which pipeline wrote the row* (`command`, `agent_end`, `hot_buffer`, `memory_sync`, `memory_sync_section`) and existing code depends on its exact values: the retrieval exclude filter (`lib/filters.ts:39-41`) and startup-orientation's dedupe/skip logic (`hooks/startup-orientation.ts:130,185`). Changing or forking its values risks those contracts. Content *origin* is orthogonal, so introduce a **new metadata key** `openclaw_sync_source` alongside the unchanged `openclaw_source: "memory_sync_section"`. Values: `"memory"` for files under `memory/`, and the per-watchPath label (e.g. `"brainstem_daily"`) or a derived slug (e.g. `"notes_brainstem"`) for watchPath files.

## Implementation

### 1. Config: `watchPaths` entries become `string | { path, source? }` (`config.ts`)

Extend the type near `SyncMemoriesConfig` (`config.ts:110-134`):

```ts
export type WatchPathEntry = {
  /** Relative to workspace root, or absolute. */
  path: string
  /** Provenance label stamped as `openclaw_sync_source` metadata. Defaults to a slug of `path`. */
  source?: string
}
```

Change `SyncMemoriesConfig.watchPaths: string[]` → `watchPaths: WatchPathEntry[]` (config.ts:115). In `parseConfig` (config.ts:565-567), normalize both input forms and sanitize the label with the same character rule `normalizeScope` uses (`config.ts:106-108` — metadata values must be alphanumeric + underscore or filters silently miss):

```ts
watchPaths: Array.isArray(smObj.watchPaths)
  ? (smObj.watchPaths as unknown[]).map((wp) => {
      if (typeof wp === "string") return { path: wp }
      const entry = wp as Record<string, unknown>
      assertAllowedKeys(entry, ["path", "source"], "hyperspell.syncMemories.watchPaths[]")
      if (typeof entry.path !== "string" || !entry.path.trim())
        throw new Error("hyperspell.syncMemories.watchPaths[] entry needs a non-empty path")
      return {
        path: entry.path,
        source: entry.source ? String(entry.source).replace(/[^a-zA-Z0-9_]/g, "_") : undefined,
      }
    })
  : [],
```

String entries (the currently documented form) keep working unchanged — this is additive.

### 2. One shared resolver for path → source (`sync/markdown.ts`)

Path resolution for watchPaths is currently duplicated in three places (`hooks/memory-sync.ts:34-36`, `hooks/memory-sync.ts:210-211`, `sync/markdown.ts:369`). Consolidate in `sync/markdown.ts` and add the source resolver next to it:

```ts
export function resolveWatchPath(workspaceDir: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(workspaceDir, p)
}

/** Slug for unlabeled watchPaths: "notes/brainstem" -> "notes_brainstem". */
function watchPathSlug(workspaceDir: string, resolved: string): string {
  const rel = path.relative(workspaceDir, resolved)
  const base = rel.startsWith("..") ? path.basename(resolved) : rel
  return base.split(path.sep).join("_").replace(/[^a-zA-Z0-9_]/g, "_")
}

/**
 * Provenance for a syncable file: the longest-prefix-matching watchPath's
 * label (explicit `source` or derived slug), else "memory" for memory/ files.
 * Longest prefix wins so a watchPath nested inside another (or inside memory/)
 * keeps its more specific label.
 */
export function resolveSyncSource(
  filePath: string,
  workspaceDir: string,
  watchPaths: WatchPathEntry[],
): string | undefined {
  let best: { len: number; label: string } | undefined
  for (const wp of watchPaths) {
    const resolved = resolveWatchPath(workspaceDir, wp.path)
    if (filePath === resolved || filePath.startsWith(resolved + path.sep)) {
      if (!best || resolved.length > best.len) {
        best = { len: resolved.length, label: wp.source ?? watchPathSlug(workspaceDir, resolved) }
      }
    }
  }
  if (best) return best.label
  const memoryDir = path.join(workspaceDir, "memory")
  if (filePath.startsWith(memoryDir + path.sep)) return "memory"
  return undefined
}
```

### 3. Thread the label through the sync functions (`sync/markdown.ts`)

- `getSyncableFiles(workspaceDir, watchPaths?, ignorePaths?)` (markdown.ts:359): change `watchPaths?: string[]` → `watchPaths?: WatchPathEntry[]`; the body's `wp.startsWith("/") ? wp : path.join(...)` (markdown.ts:369) becomes `resolveWatchPath(workspaceDir, wp.path)`. Return shape stays `string[]` — callers get provenance from `resolveSyncSource`, so no shape churn.
- `syncMarkdownFileSectionized(client, filePath, workspaceDir, options?)` (markdown.ts:455): add `options.syncSource?: string`; in the `client.addMemory` metadata block (markdown.ts:542-548) add `...(options?.syncSource ? { openclaw_sync_source: options.syncSource } : {})`.
- `syncMarkdownFile` (legacy whole-file mode, markdown.ts:405): same optional `syncSource` option, same conditional metadata key at markdown.ts:424-427.
- `syncAllFilesSectionized` (markdown.ts:653): change `options.watchPaths` type to `WatchPathEntry[]`; in the per-file loop (markdown.ts:714) compute `syncSource: resolveSyncSource(filePath, workspaceDir, options?.watchPaths ?? [])` and pass it through. Same for `syncAllMemoryFiles` if you want legacy bulk mode tagged (`"memory"` for everything — cheap, do it).

### 4. Live handler + watcher (`hooks/memory-sync.ts`)

- `buildFileSyncHandler` (memory-sync.ts:24): `cfg.syncMemoriesConfig.watchPaths` is now `WatchPathEntry[]`. Replace the local `resolvedWatchPaths` mapping (memory-sync.ts:34-36) with `resolveWatchPath` over `wp.path`. In `doSync` (memory-sync.ts:74), compute `const syncSource = resolveSyncSource(filePath, workspaceDir, watchPaths)` and pass `{ userId: syncUserId, syncSource }` to both `syncMarkdownFileSectionized` (memory-sync.ts:80-85) and `syncMarkdownFile` (memory-sync.ts:101).
- **Fix the live-path ignore asymmetry while here**: `isIgnoredPath` (memory-sync.ts:44-49) only checks segments relative to `memoryDir` and returns `false` for anything outside it, so a file under `notes/brainstem/.drafts/` would live-sync even though the bulk walk skips it (`isIgnoredEntry`, markdown.ts:316-320). Generalize: find the containing watch root (memoryDir or a resolved watchPath), compute segments relative to *that* root, and apply the same dot-dir + `ignoreDirs` check. This keeps the documented "walk and live path exclude identically" invariant (comment at memory-sync.ts:38-43) true for watchPaths.
- `startFileWatcher` (memory-sync.ts:204): keep `opts.watchPaths?: string[]` (it only needs directories); callers map entries to paths.
- `syncMemoriesOnStartup` (memory-sync.ts:143): `options.watchPaths` type → `WatchPathEntry[]` (it just forwards to `syncAllFilesSectionized`).

### 5. Wiring (`index.ts`)

At index.ts:295-308, `syncMemoriesOnStartup` already receives `cfg.syncMemoriesConfig.watchPaths` — type flows through. The watcher call becomes:

```ts
stopFileWatcher = startFileWatcher(buildFileSyncHandler(client, cfg), {
  workspaceDir,
  watchPaths: cfg.syncMemoriesConfig.watchPaths.map((wp) => wp.path),
})
```

Optional but recommended testability refactor: `buildFileSyncHandler` currently calls `getWorkspaceDir()` internally (memory-sync.ts:25), which reads env/config paths (config.ts:625+). Accept `workspaceDir` as a third parameter (index.ts already has it in scope) so the handler is unit-testable without env manipulation.

### 6. README

- In the tuning block (README.md:182-190), replace the bare `"watchPaths": []` comment with both forms and the motivating example:

```jsonc
"watchPaths": [
  "notes",                                                 // plain path — tagged with slug "notes"
  { "path": "notes/brainstem", "source": "brainstem_daily" } // labeled — tagged openclaw_sync_source: "brainstem_daily"
]
```

- Add a short "Provenance" paragraph under **How it works** (README.md:171-178): every synced memory carries `openclaw_sync_source` metadata (`"memory"` for `memory/` files, the label/slug for watchPath files), and note that already-synced content is not retroactively retagged (hash-gated — see rollout below).
- Explicitly call out the issue's scenario: external tools that write dated markdown reports under the workspace (nightly consolidators, journal generators) should be added to `watchPaths`; they are picked up by both startup bulk sync and the live watcher.

## Tests

All in the existing `node:test` + `--experimental-strip-types` style; the three target files are already in the `package.json` test list, so no script changes.

**`config.test.ts`** (pattern: `parseConfig` over a `base` object):
- string entries normalize to `{ path }`: `watchPaths: ["notes/brainstem"]` → `[{ path: "notes/brainstem" }]`
- object entry with `source` parses; `source: "brainstem-daily"` sanitizes to `brainstem_daily`
- entry with unknown key (e.g. `sources`) throws via `assertAllowedKeys`
- entry missing `path` throws
- default stays `[]`

**`sync/markdown.test.ts`** (reuse `makeClient`/`workspace` helpers at markdown.test.ts:274-300; extend `AddOptions` to capture `metadata`):
- `resolveSyncSource`: memory/ file → `"memory"`; file under labeled watchPath → label; unlabeled → slug (`notes_brainstem`); nested watchPath beats a shorter-prefix one (longest-prefix rule); unmatched file → `undefined`
- `syncMarkdownFileSectionized` with `syncSource: "brainstem_daily"` → every `addCalls[i].options.metadata.openclaw_sync_source === "brainstem_daily"`, and `openclaw_source` still `"memory_sync_section"`
- `syncAllFilesSectionized` with a `notes/brainstem/2026-07-06.md` fixture plus a `memory/note.md` fixture and `watchPaths: [{ path: "notes/brainstem", source: "brainstem_daily" }]` → both files sync; metadata tags are `brainstem_daily` and `memory` respectively
- `getSyncableFiles` accepts entry objects (regression for the type change) and still dedupes overlap with `memory/`
- dot-dir under a watchPath (`notes/brainstem/.drafts/x.md`) is excluded from the walk

**`hooks/memory-sync.test.ts`** (pattern: temp workspace + real `fs.watch`, see `writeUntilObserved` at memory-sync.test.ts:22-36):
- `buildFileSyncHandler` (with the `workspaceDir` param refactor and `debounceMs: 0` in a minimal cfg) invoked with `{ file_path: <workspace>/notes/brainstem/2026-07-06.md }` → stub client's `addMemory` called with `openclaw_sync_source: "brainstem_daily"`
- handler ignores a file under `notes/brainstem/.drafts/` (live-path ignore parity test)
- existing `startFileWatcher` watchPaths test (memory-sync.test.ts:54-71) already proves extra-dir events fire — unchanged

## Edge cases and rollout

- **Re-sync of newly added paths is automatic**: files under a freshly configured watchPath are not in the sync manifest, and the `maxAgeDays` startup pre-filter only skips files *already recorded in the manifest* (markdown.ts:679-700), so even months-old brainstem dailies ingest once on the next startup. No extra migration needed.
- **No double-upload / no retroactive retag**: uploads are gated by per-section content hash, and the manifest is keyed by content, not metadata. Adding `openclaw_sync_source` therefore does not re-upload unchanged already-synced sections — but it also means previously synced content keeps its old (untagged) metadata until its content next changes. Acceptable for this feature; document it. (A forced backfill would require deleting the manifest entry or a `resync` command — out of scope, note as follow-up if provenance-complete history matters.)
- **Retrieval filters unaffected**: `EXCLUDE_SESSION_END_FILTER` (lib/filters.ts:39-41) matches only `openclaw_source: "agent_end"`; the new key is additive and post-#1921 `$ne` semantics keep untagged rows, so nothing existing is hidden.
- **Legacy `sectionize: false` mode mutates watched files**: whole-file sync writes `hyperspell_id` frontmatter back into the source file (markdown.ts:431-433) — for externally owned directories like brainstem output that means the plugin edits another tool's files. Sectionize is the default and uses the manifest instead; add a README note recommending sectionized mode for external watchPaths.
- **Recursive `fs.watch` fallback**: on platforms without recursive watch, nested watchPath files won't live-sync (memory-sync.ts:226-238); startup bulk sync catches up. Already logged; no change.
- **Deletes**: the live handler ignores deletions (memory-sync.ts:118) and sectionized sync only reaps sections of files that still exist — a deleted brainstem file leaves orphaned memories. Pre-existing behavior for `memory/` too; out of scope, worth a follow-up issue.
- **Compatibility**: config `watchPaths: ["notes/brainstem"]` (the only shipped/documented form) keeps working; the object form is purely additive. `SyncMemoriesConfig.watchPaths`'s TS type changes, but it is plugin-internal.

## Files touched

- `config.ts` — `WatchPathEntry` type, `SyncMemoriesConfig.watchPaths` type, `parseConfig` normalization + validation
- `sync/markdown.ts` — `resolveWatchPath`, `watchPathSlug`, `resolveSyncSource`; `syncSource` option on `syncMarkdownFile` / `syncMarkdownFileSectionized`; `WatchPathEntry[]` in `getSyncableFiles` / `syncAllFilesSectionized`; metadata key `openclaw_sync_source`
- `hooks/memory-sync.ts` — use shared resolver, thread `syncSource` in `doSync`, generalize `isIgnoredPath` to watchPath roots, type updates in `syncMemoriesOnStartup`; optional `workspaceDir` param on `buildFileSyncHandler`
- `index.ts` — map entries to paths for `startFileWatcher`, pass `workspaceDir` to the handler
- `README.md` — watchPaths examples (string + labeled object form), provenance metadata docs, external-notes scenario
- `config.test.ts`, `sync/markdown.test.ts`, `hooks/memory-sync.test.ts` — tests listed above
