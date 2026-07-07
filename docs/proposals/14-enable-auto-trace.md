# Idea #14 — Enable autoTrace to activate distilled memory extraction

Implementation guide for idea #14 from #66. This is a config/rollout decision, not new code: the feature is fully built, recently bug-fixed, and one flag away from active on the target install.

## 1. Summary

`autoTrace` is the plugin's only pathway that converts a full conversation transcript into *distilled* memory — `sessions.add` with `extract` runs server-side extraction that turns "what happened" into "what it meant." On the live install it is `enabled: false`, so everything feeding retrieval today is raw hot-buffer text, emotional snapshots, or manual `/remember`. Both blockers that kept it off (the `hooks.allowConversationAccess` gate and the duplicate-write bug from `event.sessionId` being undefined) are resolved. This guide recommends flipping the flag, resolves the open question about how autoTrace resources classify in `classifyResult` (definitive answer: **"other"**, not "curated" — the resource id is the session UUID), recommends adding `"memory"` to `extract`, and scopes an optional `classifyResult` follow-up separately.

## 2. Problem

Live config (`~/.openclaw/openclaw.json`, `plugins.entries.openclaw-hyperspell.config`), verified:

```json
"autoTrace": { "enabled": false, "extract": ["procedure", "mood"] },
"hotBuffer": { "enabled": true, "source": "vault", "writeUser": true, "writeAssistant": true },
"emotionalContext": true,
"debug": true,
"ranking": { "curationBoost": 0.2, "chatterPenalty": 0.25 }
```

and `plugins.entries.openclaw-hyperspell.hooks.allowConversationAccess: true` is already present — the gate `index.ts` warns about when any `agent_end` consumer is enabled is satisfied.

With `autoTrace.enabled: false`, the registration in `index.ts` (`if (cfg.autoTrace.enabled) { api.on("agent_end", unlessQuarantined(buildAutoTraceHandler(client, cfg))); api.on("session_end", buildAutoTraceSessionCleanupHandler()); }`) never runs. The consequences:

- No distillation. Hot-buffer rows are verbatim turn text; emotional snapshots are mood-only; `/remember` is manual. Nothing summarizes sessions into procedures or semantic memories.
- Retrieval is dominated by "chatter"-classified results (untitled, UUID-keyed hot-buffer fragments), managed only by penalty + quota (`chatterPenalty: 0.25`, default `chatterQuota: 2`). There is no supply of *new* well-classified memory to fill the freed slots.
- `startup-orientation.ts` even documents the gap in-code: "the agent_end-trace path only works when auto-trace is on, which it usually isn't."

The code itself is ready. `hooks/auto-trace.ts` now: reads `ctx?.sessionId` (the issue-#42 fix — `event.sessionId` does not exist on `agent_end`), debounces per-session with `TRACE_DEBOUNCE_MS = 3 * 60 * 1000`, cleans up per-session state on `session_end`, strips injected wrapper tags via `sanitizeTraceText` (breaking the re-capture pollution loop), warns on multi-speaker sessions without `multiUser`, resolves the sender to a `userId`, and sends `scope: "private"`.

## 3. Proposed design

### 3.1 The config change

In `~/.openclaw/openclaw.json` under `plugins.entries.openclaw-hyperspell.config`:

```json
"autoTrace": { "enabled": true, "extract": ["procedure", "memory"] }
```

Then restart the gateway. That is the entire main change. Everything below is the reasoning and the observation plan.

### 3.2 Resolved: what does the trace's resourceId look like, and how does it classify?

**Definitive answer: the trace resource's id is the OpenClaw session UUID, so autoTrace resources classify as `"other"` — not `"curated"`, and (importantly) not `"chatter"` either.**

The chain of evidence:

1. `client.ts` `sendTrace` passes `session_id: options?.sessionId` to `client.sessions.add` and returns `{ resourceId: result.resource_id, status: result.status }`.
2. The Hyperspell SDK (`node_modules/hyperspell/resources/sessions.d.ts`) documents the parameter explicitly: `session_id?: string` — **"Resource identifier for the trace."** The session id we pass IS the resource id. `sessions.add` returns `MemoryStatus` whose `resource_id` echoes it.
3. `buildAutoTraceHandler` sets `sessionId = ctx?.sessionId` — an OpenClaw session id, which is UUID-shaped. Two independent in-repo confirmations: `hooks/hot-buffer.ts` uses the same value directly as its `resourceId` (line ~173, `const resourceId = sessionId`), and `hooks/startup-orientation.ts` filters session resources with `UUID_RE.test(memory.resourceId)` and documents "`resource_id` = the session id (a UUID)" — verified live for this install.
4. `classifyResult` in `lib/ranking.ts`, exact branches:
   - `chatter` requires **both** untitled (empty or "Unnamed Conversation") **and** `UUID_RE.test(resourceId)`.
   - `curated` requires **both** a non-empty title **and** a non-UUID id.
   - Anything else — including **titled-but-UUID-id** — falls through to `"other"`: no boost, no penalty, no quota.

autoTrace resources get a real title (first user message, first 80 chars) but a UUID resource id → **`"other"`**.

**So does flipping the flag help the chatter/curated balance as hoped?** Partially, and honestly better than the failure mode the issue worried about:

- It does **not** add more chatter. The title check saves it from the chatter branch — no `chatterPenalty`, not counted against `chatterQuota`.
- It does **not** get `curationBoost` either. In the debug kind-tally, expect the shift to be chatter → **other**, not chatter → curated.
- Net effect is still positive: distilled, titled content competes at its raw relevance score, unpenalized, while raw fragments on the same topic remain penalized and quota-capped. But if we want autoTrace output to get full "deliberately kept" credit, a small `classifyResult` follow-up is warranted — scoped in §3.5, deliberately NOT part of this change.

### 3.3 What `extract` value to use

Current setting is `["procedure", "mood"]`. Recommendation: **`["procedure", "memory"]`** — add `"memory"`, drop `"mood"`.

- **Add `"memory"`.** The entire point of idea #14 is converting "what happened" into "what it meant." `"procedure"` extracts how-to/steps; only `"memory"` extracts the semantic/episodic distillation. Without it, we get process notes but not meaning. The config type (`config.ts` `AutoTraceConfig`) supports all three; note the SDK 0.35 typing only admits `["procedure" | "memory"]` and `sendTrace` already carries a documented cast for `"mood"` (backend accepts it per hyperspell/hyperspell#581) — `"memory"` needs no cast at all.
- **Drop `"mood"` (for now).** `emotionalContext: true` is live on this install and already captures per-session mood through the dedicated emotional-state store. Trace-side mood extraction would be a second, parallel mood pathway over the same conversations — redundant rows at best, and it feeds the known emotional-echo seam (mood distilled from transcripts that themselves contain surfaced emotional context) at worst. If mood-from-traces proves wanted later, re-add it as its own observed change so effects are attributable.
- If minimizing deltas is preferred, `["procedure", "memory", "mood"]` also works — but then a mood-noise regression can't be attributed to one change.

### 3.4 The debounce (3 minutes)

`TRACE_DEBOUNCE_MS = 3 * 60 * 1000` is a hardcoded constant, not config — changing it means a code change, which is out of scope here. Assessment for first-time activation:

- Because the resource id is the session id, re-sends within one session **upsert the same trace resource** — the debounce bounds *extraction frequency and payload cost*, not resource count. A long active session will not fan out into N resources (that was exactly the pre-fix #42 bug, now closed).
- 3 minutes is aggressive for cost: each qualifying send re-posts the full growing transcript and re-runs server-side extraction. A busy 30-minute session ≈ up to 10 full-transcript extractions.
- Verdict: **acceptable for the observation window; do not change it pre-rollout.** It mirrors the emotional-state store's debounce and its failure mode is cost, not correctness. If observation shows extraction volume is a problem, the follow-up is to lift `TRACE_DEBOUNCE_MS` into `AutoTraceConfig` (e.g. default 3 min, this install 10–15 min) — a small, separate PR.

### 3.5 Optional follow-up (separate PR): give autoTrace resources curated credit

Not required to flip the flag; do only if the observation window shows distilled traces losing rank to boosted curated content on queries where the trace is the better answer.

A naive tweak — "titled + UUID id → curated" — is **wrong**: consolidated hot-buffer session resources are also UUID-keyed and receive backend-generated titles (see `fetchRecentConversations` in `startup-orientation.ts`), so that rule would boost exactly the raw-conversation resources the ranking exists to suppress.

The correct, targeted version:

1. `sendTrace` already stamps `metadata.openclaw_source: "agent_end"` on every trace. Search responses already expose `doc.metadata` (`client.ts` uses it for `url` and `created_at`).
2. Extend `SearchResult` with e.g. `openclawSource: string | null` mapped from `doc.metadata?.openclaw_source`.
3. In `classifyResult`, before the UUID fall-through: titled + `openclawSource === "agent_end"` → `"curated"` (or a new `"distilled"` kind with its own boost if we want it tunable independently).
4. Tests: extend `lib/ranking` tests with a titled/UUID/agent_end result asserting curated, and a titled/UUID/no-source result still asserting `"other"` (the hot-buffer guard).

Effort for the follow-up alone: S (one type field, one mapping line, one branch, tests).

### 3.6 Known interaction to verify during rollout (hot buffer shares the resource key)

Both writers key on the same id for the same session: hot buffer consolidates `POST /messages` rows into a vault Resource with `resource_id = sessionId`; autoTrace sends `sessions.add` with `session_id = sessionId`, under the same resolved user. Whether the backend keeps these in separate namespaces or upserts one shared resource is **not verifiable from this repo**. If they merge, one concrete regression is possible: the trace's `openclaw_source: "agent_end"` metadata would land on the session resource, and `fetchRecentConversations` **excludes** rows with any `openclaw_source` — silently emptying startup-orientation's recent-interactions block. §4 includes an explicit check for this. If it bites, the immediate mitigation is rollback (§6) and a backend follow-up.

## 4. Test plan

`debug: true` is already set live, so the kind-tally is already being logged. The tally line (from `hooks/auto-context.ts`):

```
auto-context: injecting (ranked) {"chatter":2,"other":1,...} from N candidates (chatter cap 2)
```

**Procedure:**

1. **Baseline (before the flip):** collect ~1 week of existing gateway logs. Aggregate every `auto-context: injecting (ranked)` tally into per-kind totals (grep the log for the line, sum the JSON counts). Record the chatter / curated / story / other proportions. Also snapshot a `listMemories` page of newest vault resources for reference.
2. **Flip** the flag per §3.1 and restart the gateway.
3. **First-trace verification (day 1):**
   - Have one real conversation ≥ 3 messages and ≥ 100 chars (the `MIN_MESSAGES` / `MIN_CONVERSATION_LENGTH` gates in `auto-trace.ts`), let `agent_end` fire.
   - Confirm the log line `auto-trace: sent <resourceId> (N messages...)` and that `<resourceId>` equals the session UUID (this empirically confirms §3.2's SDK-derived answer end-to-end).
   - List newest vault memories: find the trace resource; note its title (should be the first user message, truncated to 80 chars) and whether any *derived* extraction resources appeared alongside it — record their ids/titles, since their own classification shape is the one thing not derivable from this repo.
   - **Hot-buffer interaction check (§3.6):** fetch the session's resource; verify hot-buffer content and the trace coexist sanely, and verify the session still appears in startup-orientation's recent-interactions on the next fresh session (if it vanished, `openclaw_source` merged onto the shared resource — roll back and file a backend issue).
4. **Observation window (1–2 weeks):** re-aggregate the tally the same way.
5. **Success criteria:**
   - The chatter share of injected results drops, with a corresponding rise in `other` (per §3.2 — expect `other`, not `curated`, unless §3.5 ships).
   - Spot-check: for a few queries about topics discussed since the flip, the injected context contains distilled trace/extraction content rather than (or ahead of) raw fragments.
   - No recurrence of the duplicate-write signature (`docs/issue42-resourceid-probe.mjs` can re-verify: many distinct UUID resources ~1 turn each, seconds apart = bug; one session-keyed resource = healthy).
   - startup-orientation's recent-interactions block still populates.
6. **Quality gate (subjective but required):** read the extracted procedure/memory items themselves. If they restate injected context, misattribute speakers, or invent meaning, that's a content-quality problem no tally will show.

## 5. Risks / tradeoffs

- **Write volume & cost.** Each qualifying session sends full transcripts every ≥3 min plus server-side extraction (an LLM pass). On a chatty single-user install this is bounded but nonzero backend cost. Mitigation: observe; make the debounce configurable later if needed (§3.4).
- **Extraction quality is unproven on this corpus.** `"memory"` extraction could itself produce noise — confidently-worded distillations of casual chatter. That's why `"mood"` is dropped (attributability) and why §4 step 6 exists. New noise here would classify as titled resources, i.e. *unpenalized* — bad extractions are more visible than bad hot-buffer rows, not less.
- **Pollution loop is guarded but semantic echo isn't.** `sanitizeTraceText` strips injected wrapper tags structurally, but a transcript *discussing* surfaced memories still gets distilled; memories-about-memories can compound. Watch for it in step 6.
- **Title fidelity.** The title is taken from the raw first user message *before* sanitization (`auto-trace.ts` builds it from `firstUser.content` directly), so a session whose first user message carries injected preamble can get an ugly/wrapper-ish title. Cosmetic; if it shows up, a one-line fix (sanitize before slicing) is a trivial follow-up.
- **Multi-speaker sessions.** Without `multiUser`, group-chat traces mix speakers under one user id. The handler warns (once per session) rather than skips. This install is effectively single-user, so accepted; revisit if group channels appear.
- **Hot-buffer key collision** (§3.6) — the one genuinely unknown interaction; explicitly checked on day 1.
- **Privacy posture is already conservative:** traces are sent `scope: "private"`, and quarantined channels (`excludeChannels`) are excluded by the `unlessQuarantined` wrapper.

## 6. Rollout

Opt-in, single install, one key:

1. Edit `~/.openclaw/openclaw.json` → `plugins.entries.openclaw-hyperspell.config.autoTrace` → `{ "enabled": true, "extract": ["procedure", "memory"] }`.
2. Restart the gateway (confirm with the operator first — this is a live personal agent).
3. Run §4 steps 3–6.

**Rollback:** set `enabled` back to `false`, restart. Registration is fully conditional, so the hook simply stops firing. Data written during the window persists but is inert and deletable: trace resources are identifiable by `metadata.openclaw_source: "agent_end"` (and session-UUID resource ids) and can be removed via `memories.delete` if a purge is wanted. No schema, no migration, no other installs affected.

## 7. Effort estimate

**S** — one config key on one install plus a defined observation procedure; the only code-shaped items (§3.5 classify tweak, debounce configurability, title sanitization) are optional follow-ups, each themselves S.
