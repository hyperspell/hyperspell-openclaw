# OpenClaw issue draft: CLI agent runs inherit the main session's identity context

**Repo to file against:** openclaw (host), from David's account.
**Severity:** memory-integrity — plugins cannot distinguish operator-driven
peer turns from the human's own conversation, so authorship-sensitive
writes (relationship registers, speaker-labeled conversation rows) are
silently mis-attributed.

## Observed (2026-08-24, gateway 2026.7.2, live install)

A Claude Code session drove agent turns via:

    openclaw agent --agent main --session-key "agent:main:claude-code-plugin-review" --message ...

On the resulting `agent_end` hook context, the memory plugin observed:

    trigger=user
    senderId=689590407323189323        <- the OPERATOR's id (requester), not "no sender"
    channelId=1469324503380267153      <- the main session's channel
    ctx.sessionKey=agent:main:main     <- NOT the CLI-supplied session key

The only field that distinguished the peer session was `ctx.sessionId`
(`db59b698-...` vs the main conversation's id) — which rotates and cannot
be configured against.

## Consequences observed live

1. The plugin's emotional-register sender gate ("only a resolvable human
   sender may write the relationship register") passed peer-agent turns
   because they wear the human's sender id. A peer code-review session
   wrote registers into the david-alinea relationship record four times
   (es-o3ySb-x-n6E at 17:26:08 was written WITH the gate active).
2. Hot-buffer speaker labeling stamped the peer agent's words as
   `[David]:` in permanently stored conversation rows — the agent's own
   recent-interactions recall then served the reviewer's words under the
   human's name.

## Ask

On hook contexts for CLI/programmatically-driven runs:
- pass the CLI-supplied `--session-key` through as `ctx.sessionKey`
  (currently collapsed to the agent main key), and/or
- distinguish `requesterSenderId` (who invoked the run) from `senderId`
  (who authored the message content), leaving `senderId` unset for
  turns not authored by a connector-identified human, and/or
- stamp an origin field (`ctx.origin: "cli" | "channel" | "cron" | ...`).

Any one of the three restores the ability to gate authorship-sensitive
writes. The first two match metadata the gateway already has at the
boundary and discards.

## Local workaround until fixed

None that holds: sender id, channel id, session key, and trigger are all
inherited from the main context. The operator's mitigation is
procedural — peer agents must not message agents whose plugins write
authorship-sensitive memory. Cleanup of the mis-attributed rows
(registers es-* from the review windows; hot-buffer rows under session
db59b698-...) is tracked separately.
