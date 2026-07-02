import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  channelIdFromCtx,
  conversationIdFromSessionKey,
  isExcludedChannel,
} from "./exclude-channels.ts"

describe("conversationIdFromSessionKey", () => {
  it("extracts the id from an agent-prefixed channel key", () => {
    assert.equal(
      conversationIdFromSessionKey("agent:main:discord:channel:1521620672726438171"),
      "1521620672726438171",
    )
  })

  it("extracts the id from a group key without agent prefix", () => {
    assert.equal(conversationIdFromSessionKey("whatsapp:group:abc123"), "abc123")
  })

  it("keeps thread suffixes attached", () => {
    assert.equal(
      conversationIdFromSessionKey("agent:main:discord:channel:123:thread:456"),
      "123:thread:456",
    )
  })

  it("returns undefined for keys with no conversation segment", () => {
    assert.equal(conversationIdFromSessionKey("agent:main:cron:job1:run:uuid"), undefined)
    assert.equal(
      conversationIdFromSessionKey("0f0e4b3a-1111-4222-8333-444455556666"),
      undefined,
    )
    assert.equal(conversationIdFromSessionKey(undefined), undefined)
    assert.equal(conversationIdFromSessionKey(""), undefined)
  })
})

describe("channelIdFromCtx", () => {
  it("prefers ctx.channelId over sessionKey", () => {
    assert.equal(
      channelIdFromCtx({ channelId: "111", sessionKey: "agent:main:discord:channel:222" }),
      "111",
    )
  })

  it("falls back to sessionKey when channelId is absent", () => {
    assert.equal(
      channelIdFromCtx({ sessionKey: "agent:main:discord:channel:222" }),
      "222",
    )
  })

  it("returns undefined with neither", () => {
    assert.equal(channelIdFromCtx({}), undefined)
    assert.equal(channelIdFromCtx(undefined), undefined)
  })
})

describe("isExcludedChannel", () => {
  const cfg = { excludeChannels: ["1521620672726438171"] }

  it("matches by ctx.channelId", () => {
    assert.equal(isExcludedChannel({ channelId: "1521620672726438171" }, cfg), true)
  })

  it("matches by sessionKey fallback (tool factory ctx)", () => {
    assert.equal(
      isExcludedChannel(
        { sessionKey: "agent:main:discord:channel:1521620672726438171" },
        cfg,
      ),
      true,
    )
  })

  it("quarantines threads inside an excluded channel", () => {
    assert.equal(
      isExcludedChannel({ channelId: "1521620672726438171:thread:9" }, cfg),
      true,
    )
  })

  it("matches case-insensitively", () => {
    assert.equal(
      isExcludedChannel({ channelId: "ABCdef" }, { excludeChannels: ["abcDEF"] }),
      true,
    )
  })

  it("does not match other channels or prefixes-without-separator", () => {
    assert.equal(isExcludedChannel({ channelId: "9999" }, cfg), false)
    // A longer id sharing the excluded id as a bare prefix is a DIFFERENT channel.
    assert.equal(isExcludedChannel({ channelId: "15216206727264381719" }, cfg), false)
  })

  it("is inert with an empty list or unresolvable context", () => {
    assert.equal(isExcludedChannel({ channelId: "1" }, { excludeChannels: [] }), false)
    assert.equal(isExcludedChannel({}, cfg), false)
    assert.equal(isExcludedChannel(undefined, cfg), false)
  })
})
