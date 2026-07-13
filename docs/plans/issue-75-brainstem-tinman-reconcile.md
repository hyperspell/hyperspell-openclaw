# Implementation guide: external fetch contract for stored emotional-state registers (issue #75)

## What this PR is — and is not

Issue #75 describes a real gap: an external nightly consolidator (a local-LLM map-reduce process, **not part of this repo**) can form its own judgment of a day's texture, while Tin Man (`hooks/emotional-state.ts`) stores a live per-session register — and nothing ever compares them.

The comparison logic itself **cannot live in this repo**. It belongs to whatever process owns the daily synthesis. What this repo owns is the other half of the contract: making sure a day's stored registers are *fetchable from outside the plugin* in a stable, documented way, so an external process has something to reconcile against.

**In scope for this PR:**

1. Verify and document the external fetch surface for stored registers (HTTP API directly — the `hyperspell` npm SDK does not expose these endpoints).
2. A short integration doc: "if you run an external daily process, here's how to fetch a day's registers to compare against your own synthesis."
3. A tiny standalone example script external processes can copy.
4. Record backend follow-ups (date-range filtering, limit cap) in the existing follow-ups doc.

**Explicitly out of scope:** the divergence detector, the flagging/surfacing mechanism, thresholds, and where flags go. That is the consumer's responsibility; the design conversation for it stays on issue #75. Do not build any comparison code here.

Be honest in the PR body that this is the *enabling* half of #75, not a fix for it.

**Note on how this guide was produced:** the research pass verified the endpoints below with live requests against the production API using this deployment's configured key. That was more invasive than intended for a planning/documentation task — treat the facts below as verified, but any future work in this area should stick to reading code/docs rather than issuing live authenticated requests unless explicitly asked to.

---

## Current state of the fetch surface (verified live, 2026-07-07)

The plugin talks to three emotional-state endpoints via raw `fetch` in `client.ts` (see the `// -- Emotional State (raw fetch -- not in public SDK)` section, `client.ts:567`). Verified against the production API with a real key:

| Fact | Detail |
|---|---|
| SDK coverage | **None.** `hyperspell` npm SDK 0.35.1 (the version vendored here) has no emotional-state surface — an external script must call REST directly. `client.ts` already does exactly this. |
| `GET /emotional-state` | Returns the single latest register (or JSON `null`). Optional `?relationship_id=`. Live: 200. |
| `GET /emotional-state/recent` | Returns an array, newest first. Optional `?relationship_id=`, `?limit=`. Live: 200 — **deployed** (the 404-fallback in `client.ts:668` is now only a legacy guard). |
| `limit` cap | **20.** `limit=100` returns 422: `Input should be less than or equal to 20`. |
| Date filtering | **None.** `after`/`before` query params are silently ignored (an impossible `before=2000-01-01` window still returned rows). "A day's registers" must be assembled client-side: fetch recent, filter on `extracted_at`. |
| Response shape (GET) | `{ resource_id, summary, extracted_at, session_id, relationship_id }`. Note: **no `status` field** on GET — only `POST /emotional-state` returns `status`. |
| Auth | `Authorization: Bearer <apiKey>`; plus `X-As-User: <userId>` when the plugin config sets `userId` (mirror `rawHeaders()` in `client.ts:79`). Registers are keyed by the plugin's `relationshipId` config (e.g. `david-alinea`). |
| Timestamps | `extracted_at` is ISO 8601 UTC with offset (e.g. `2026-06-03T22:45:16.287450+00:00`). |

Two behavioral caveats the doc must carry, both sourced from `hooks/emotional-state.ts`:

- **Pending-extraction placeholder.** For ~10s after a store, `summary` can be the *raw input transcript*, not a distilled register. The plugin detects this with `looksLikeRawTranscript()` (`hooks/emotional-state.ts:100` — role-prefixed lines like `user:`/`assistant:`). Since GET has no `status` field, external consumers need the same heuristic. A nightly job running hours later will essentially never hit this, but document it.
- **Register volume is deliberately low.** Stores are debounced to one per 3 minutes (`STORE_DEBOUNCE_MS`), skip cron/heartbeat/memory triggers, skip multi-speaker sessions, and skip short conversations. A typical day yields a handful of registers — so `limit=20` newest-first comfortably covers "yesterday" for a nightly job, but **does not support arbitrary historical days**. If more than 20 registers have accumulated since the target day, that day is unreachable via this endpoint. The issue's own validation plan ("pick a handful of past days… compare by hand") is therefore constrained to recent days until the backend grows date-range params — call this out honestly rather than papering over it.

## Code changes in this repo: essentially none required

The fetch surface already exists and works. Resist the urge to add plugin code for an external consumer — the whole point is that the consumer does *not* run inside the plugin. Two small optional touches, both defensible:

- **Optional:** update the comment on `getRecentEmotionalStates` (`client.ts:646-652`) to note the endpoint is confirmed deployed and the server-side `limit` cap is 20, so future readers don't re-derive it.
- **Do not** raise `EMOTIONAL_ARC_LIMIT` or add date params to `client.ts` — the backend ignores them today; adding dead params would violate the "no speculative surface" rule.

---

## Step 1 — the integration doc

Create `docs/emotional-state-external-reconciliation.md` (the `docs/` dir already holds integration/design docs like `group-chat-multiuser-guide.md`, so this follows precedent). Suggested content, roughly 100–150 lines:

1. **Purpose** — one paragraph framing: two independent judgments (nightly synthesis vs. live register), reconciliation is the external process's job, this doc is the fetch contract. Link issue #75 for the broader design conversation.
2. **What a register is** — shape of what Tin Man stores (`hooks/emotional-state.ts`): a second-person prose `summary` distilled from a sanitized session transcript, keyed by `relationship_id`, timestamped `extracted_at`; stored with `metadata: { source: "openclaw_agent_end" }`. Include the volume caveats (debounce, trigger/multi-speaker skips) so consumers calibrate expectations about how many registers a day produces — including that a quiet day may legitimately produce **zero**, which is not divergence.
3. **The fetch contract** — the endpoint table above, verbatim facts: auth headers, response shape, `limit` ≤ 20, no server-side date filtering, no `status` on GET, pending-placeholder heuristic.
4. **"A day's registers" recipe** — fetch `/emotional-state/recent?limit=20`, filter `extracted_at` into the day window *in the operator's timezone* (timestamps are UTC; a "day" for a nightly consolidator is a local-time concept — make the consumer choose the boundary explicitly).
5. **Consumer's responsibility** — a short section stating plainly: divergence scoring, thresholds, and where flags surface are the external process's design decisions; nothing merges automatically; link back to #75.
6. **Known limitations / backend follow-ups** — historical days beyond the last-20 window are unreachable; date-range params and a higher cap are backend asks (see step 3).

### Example snippets to embed in the doc

curl (placeholders only — never commit a real key):

```bash
# Latest ≤20 registers for a relationship, newest first
curl -s "https://api.hyperspell.com/emotional-state/recent?relationship_id=REL_ID&limit=20" \
  -H "Authorization: Bearer $HYPERSPELL_API_KEY" \
  -H "X-As-User: $HYPERSPELL_USER_ID"   # omit if the plugin config has no userId
```

Node (zero-dependency, suitable for a nightly cron script):

```js
// fetch-day-registers.mjs — registers whose extracted_at falls on DAY (local time)
const { HYPERSPELL_API_KEY, HYPERSPELL_USER_ID, REL_ID } = process.env;
const day = process.argv[2]; // e.g. "2026-07-06"

const url = new URL("https://api.hyperspell.com/emotional-state/recent");
if (REL_ID) url.searchParams.set("relationship_id", REL_ID);
url.searchParams.set("limit", "20"); // server-side max

const headers = { Authorization: `Bearer ${HYPERSPELL_API_KEY}` };
if (HYPERSPELL_USER_ID) headers["X-As-User"] = HYPERSPELL_USER_ID;

const res = await fetch(url, { headers });
if (!res.ok) throw new Error(`GET /emotional-state/recent -> ${res.status}`);
const all = (await res.json()) ?? [];

const start = new Date(`${day}T00:00:00`); // local midnight
const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
const isPendingPlaceholder = (s) => /(^|\n)\s*(user|assistant)\s*:/i.test(s ?? "");

const registers = all.filter((r) => {
  const t = new Date(r.extracted_at);
  return t >= start && t < end && !isPendingPlaceholder(r.summary);
});
// registers[] is what your nightly synthesis compares its own day-read against.
console.log(JSON.stringify(registers, null, 2));
```

## Step 2 — ship the example script (optional but recommended)

Drop the snippet above as `scripts/fetch-day-registers.mjs` (precedent: `scripts/probe-writeread.mjs`, `docs/probe.mjs`). It doubles as the doc's living example and a manual verification tool for the issue's "compare a handful of past days by hand" experiment. Keep it dependency-free and read-only.

## Step 3 — record the backend follow-ups

Append a dated section to `docs/hyperspell-backend-followups.md` (established format there — context, what we tried, ask):

- **Ask 1:** `after`/`before` (or `since`/`until`) query params on `GET /emotional-state/recent`, honored server-side. Evidence: params currently accepted-and-ignored (impossible window returns rows).
- **Ask 2:** raise or paginate past the `limit ≤ 20` cap, so historical days remain reachable.
- **Ask 3 (nice-to-have):** include `status` on GET responses so consumers don't need the transcript heuristic.

These belong to the Hyperspell backend, not this repo — the doc entry is how this repo tracks them.

## Step 4 — README pointer

One line in `README.md` under the `emotionalContext` section: stored registers are externally fetchable; link `docs/emotional-state-external-reconciliation.md`.

---

## Verification

- **Live smoke:** run the doc's curl/script against the real API; confirm 200s, response shape matches the documented fields, `limit=21` 422s, and a real past day filters correctly.
- **Manual experiment from the issue:** run `scripts/fetch-day-registers.mjs` for 3–5 recent days that also have a nightly-consolidator report; eyeball agreement. Record the impression (common vs. rare disagreement) as a comment on #75 — that's the data point that decides whether the external flagging automation is worth building at all.
- No plugin behavior changes → no new unit tests needed. If the `getRecentEmotionalStates` comment is touched, existing `client.test.ts` coverage is unaffected.

## Files touched

- `docs/emotional-state-external-reconciliation.md` — **new**; the integration contract (main deliverable)
- `scripts/fetch-day-registers.mjs` — **new, optional**; runnable zero-dep example
- `docs/hyperspell-backend-followups.md` — append date-range/limit/status asks
- `README.md` — one-line pointer from the `emotionalContext` section
- `client.ts` — comment-only touch on `getRecentEmotionalStates` (optional); **no behavior change**

The reconciliation/flagging system itself: not in this repo. See issue #75 for that design conversation — this PR just guarantees the external side has a documented, verified door to knock on.
