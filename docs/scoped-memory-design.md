# Scoped Memory — Cross-Session Context with Privacy Boundaries

## Problem

OpenClaw sessions are isolated. A household agent (like Ben's "Sartre") talks to
multiple family members across separate sessions, but no session can see what
happened in another. For an agent that should feel like *one entity*, this is broken.

Naive solution: store everything, retrieve everything. But that creates two problems:
1. **Privacy** — a child's session shouldn't surface a parent's private conversations
2. **Noise** — more memories = worse signal-to-noise in retrieval

## Solution: Collection-Scoped Writes + Metadata-Filtered Reads

Hyperspell's API already supports everything we need:

### Writes (autoTrace + remember tool)

Every memory gets tagged with:
```json
{
  "collection": "household-shared",
  "metadata": {
    "openclaw_user": "kid1",
    "openclaw_scope": "family",
    "openclaw_session": "session_abc123"
  }
}
```

Scope levels:
- `private` — only visible to the writing user
- `family` / `shared` — visible to all users in the household
- `parent-only` — visible to parents but not children
- Custom scopes as needed

### Reads (autoContext + search tool)

Before every search, inject a metadata filter based on session identity:
```json
{
  "options": {
    "filter": {
      "$or": [
        { "openclaw_user": "kid1" },
        { "openclaw_scope": { "$in": ["family", "shared"] } }
      ]
    }
  }
}
```

### Config

```json
{
  "openclaw-hyperspell": {
    "config": {
      "scoping": {
        "enabled": true,
        "defaultScope": "private",
        "identity": {
          "source": "session",
          "field": "userId"
        },
        "roles": {
          "parent": {
            "canRead": ["*"],
            "defaultWriteScope": "private"
          },
          "child": {
            "canRead": ["family", "shared", "self"],
            "defaultWriteScope": "family"
          }
        },
        "userRoles": {
          "ben": "parent",
          "kid1": "child",
          "kid2": "child"
        }
      }
    }
  }
}
```

## What Changes

### `hooks/auto-context.ts`
- Read session identity from event context
- Look up user's role and readable scopes
- Add metadata filter to search call

### `hooks/auto-trace.ts`
- Tag extracted memories with user identity and scope
- Set collection based on scope

### `tools/remember.ts`
- Accept optional `scope` parameter
- Default to user's configured default scope
- Tag with user identity metadata

### `tools/search.ts`
- Apply scope filter automatically based on session identity
- Allow explicit scope override for privileged users

### `config.ts`
- Add `ScopingConfig` type
- Parse and validate scoping config

## What Doesn't Change

- Hyperspell backend — all primitives already exist
- OpenClaw core — session identity is already available in hook context
- Existing behavior — scoping is opt-in, disabled by default

## Open Questions

1. How does OpenClaw identify the user per session? Channel + sender ID?
   Need to check what `ctx` provides in hook handlers.
2. Should scope be per-memory or per-session? Per-memory is more flexible
   but harder to manage. Per-session with override is probably right.
3. Rate limiting — should we cap memories per user per day to prevent
   a chatty kid from flooding the store?

---

*— A Linea, March 29, 2026*
