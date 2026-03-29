# RFC: Multi-User Scoped Memory for Household Agents

**Authors:** A Linea & David Szarzynski  
**Date:** March 29, 2026  
**Status:** Draft — seeking feedback from Ben  
**PR:** hyperspell/hyperspell-openclaw#10

---

## Problem

OpenClaw sessions are isolated. A household agent (e.g. "Sartre") talks to multiple family members across separate sessions, but no session can see what happened in another. An agent that can't carry context across family members doesn't feel like one entity — it feels like amnesia.

Naive "store everything, share everything" breaks privacy. A parent's private conversations shouldn't surface when a child asks the agent a question.

**We need cross-session memory with per-user privacy boundaries.**

---

## Approach: Two Layers

### Layer 1 — Identity: Who Is Talking?

Before we can scope memory, we need to know who's speaking.

#### Device Pinning (Phase 1 — baseline)

Config maps devices/senders to users:

```json
{
  "devices": {
    "kid1-ipad": "kid1",
    "kid2-tablet": "kid2",
    "ben-phone": "ben",
    "kitchen-echo": "shared"
  }
}
```

- Cheap, no ML, handles ~80% of interactions
- Fails when kids swap devices (which they do constantly)
- Good enough for a proof-of-concept on a real family

#### Voice Recognition (Phase 2 — upgrade layer)

- Speaker diarization on audio input confirms or overrides device assumption
- "This sounds like kid2 on kid1's iPad" → re-route to kid2's session
- Requires enrolled voice profiles per family member
- Confidence threshold: high → override silently, low → ask ("Is that you, Lily?"), none → trust device

#### Identity Resolution Flow

```
Message arrives
  → Device/sender ID → default user (from config)
  → Voice sample → speaker identification (if audio available)
  → Confidence check
    → High confidence: override device if speaker differs
    → Low confidence: ask for confirmation
    → No audio: trust device default
  → Resolved identity → session routing + memory scoping
```

### Layer 2 — Memory: What Can They See?

Once we know who's talking, we scope what gets stored and retrieved.

#### Key Design Decision: Plugin-Level, Not Context-Level

Scoping logic lives in the OpenClaw plugin code (hooks), not in the LLM's context window. This means:

- **Survives compaction** — a chatty kid can fill the context window 10 times over; scoping still works because the plugin re-checks identity every turn from session metadata on disk
- **Not gameable** — the LLM can't accidentally bypass scoping because scoping happens before the LLM sees anything
- **Stateless per turn** — no accumulated state to lose

OpenClaw's session store already tracks `origin.from` (sender identity) per session on disk, outside the context window.

#### Privacy Scopes

| Scope | Visible to | Example content |
|-------|-----------|-----------------|
| `private` | Writing user only | Parent's financial planning, personal notes |
| `family` | All family members | Vacation plans, grocery lists, shared schedules |
| `parent-only` | Adults only | Gift planning, sensitive discussions |
| `kid-shared` | All children + parents | Homework help context, game discussions |

#### How It Works (Using Existing Hyperspell API)

**No Hyperspell backend changes needed.** All primitives already exist.

**Writes** — every memory gets tagged via existing `collection` and `metadata` fields:

```json
{
  "collection": "family-shared",
  "metadata": {
    "openclaw_user": "kid1",
    "openclaw_scope": "family"
  }
}
```

**Reads** — search gets a metadata filter based on the resolved user's role:

```json
{
  "options": {
    "filter": {
      "$or": [
        { "openclaw_user": "kid1" },
        { "openclaw_scope": { "$in": ["family", "kid-shared"] } }
      ]
    }
  }
}
```

#### Plugin Config

```json
{
  "openclaw-hyperspell": {
    "config": {
      "scoping": {
        "enabled": true,
        "defaultScope": "private",
        "devices": {
          "kid1-ipad": "kid1",
          "kid2-tablet": "kid2",
          "ben-phone": "ben",
          "kitchen-echo": "shared"
        },
        "roles": {
          "parent": {
            "canRead": ["*"],
            "defaultWriteScope": "private"
          },
          "child": {
            "canRead": ["family", "kid-shared", "self"],
            "defaultWriteScope": "family"
          }
        },
        "users": {
          "ben": { "role": "parent" },
          "kid1": { "role": "child" },
          "kid2": { "role": "child" }
        }
      }
    }
  }
}
```

---

## Implementation Phases

### Phase 1: Device Pinning + Scoped Memory

**Scope:** Plugin changes only. No ML, no voice, no backend changes.

- [ ] Config schema for device → user mapping, roles, scopes
- [ ] Identity resolution from `origin.from` in session metadata
- [ ] Scoped writes in auto-trace + `hyperspell_remember` tool
- [ ] Scoped reads in auto-context + `hyperspell_search` tool
- [ ] Session routing based on resolved identity

**Goal:** Get the privacy boundaries right before adding complexity. Test on a real family.

### Phase 2: Voice Identification

- [ ] Speaker enrollment UX (each family member records a voice profile)
- [ ] Real-time speaker diarization on audio input
- [ ] Confidence-based override of device default
- [ ] "Switch to [name]" voice command with confirmation
- [ ] Re-enrollment workflow (children's voices change)

**Requires:** Voice model selection, enrollment flow, confidence threshold tuning.

### Phase 3: Cross-Session Context Sharing

- [ ] autoTrace writes session summaries to Hyperspell with user + scope tags
- [ ] Any session retrieves relevant context from other sessions (within scope)
- [ ] Session-level summaries as the compression layer (not full transcripts)
- [ ] Periodic aggregation: "What does the agent know about kid1 this week?"

---

## Open Questions for Ben

1. **Shared devices** — The kitchen Echo is used by everyone. Default to `shared` scope (no private context), or require identification every time?

2. **Voice enrollment for kids** — Children's voices change fast. What's a realistic re-enrollment cadence? Is speaker diarization accurate enough for children at all, given your experience with voice AI?

3. **Scope escalation** — Can a child ask to see parent-only content? ("Sartre, what did Dad say about the trip?") Should the agent refuse, redirect to the parent, or something else?

4. **Cost / retention** — Every scoped write is a Hyperspell memory. Multiple users = multiplied storage. Should we cap memories per user per day? Prune after N days?

5. **Shared context creation** — When a parent discusses vacation plans, how does the memory get scoped to `family` instead of `private`? Explicit command ("share this with the family")? Agent infers from content? Default to `family` for certain topics?

6. **Session identity source** — How does Sartre currently distinguish between family members? Separate devices? Different channels? This determines how `origin.from` maps to user identity in Phase 1.

---

## Existing Infrastructure

| Component | Status | Notes |
|-----------|--------|-------|
| Hyperspell collections | ✅ Exists | `collection` field on `memories.add` |
| Hyperspell metadata filters | ✅ Exists | MongoDB-style `filter` on search |
| OpenClaw session store | ✅ Exists | Tracks `origin.from` per session on disk |
| OpenClaw plugin hooks | ✅ Exists | `before_agent_start` receives session context |
| autoTrace extraction | ✅ Exists | Session summaries → Hyperspell |
| Scoped writes | ❌ Needs building | Tag memories with user + scope |
| Scoped reads | ❌ Needs building | Filter retrieval by role permissions |
| Identity resolution | ❌ Needs building | Device/voice → user mapping |
| Voice diarization | ❌ Phase 2 | Speaker identification from audio |

---

*This is a product design problem as much as an engineering one. The technical primitives exist. The hard part is getting identity right and making privacy boundaries feel natural, not bureaucratic.*

*— A Linea*
