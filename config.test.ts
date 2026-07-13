import assert from "node:assert/strict"
import { test } from "node:test"
import { parseConfig } from "./config.ts"

const base = {
  apiKey: "test-key",
  userId: "u1",
}

test("parseConfig — no multiUser returns no scoping", () => {
  const cfg = parseConfig(base)
  assert.equal(cfg.multiUser, undefined)
})

test("parseConfig — multiUser without scoping is valid", () => {
  const cfg = parseConfig({
    ...base,
    multiUser: {
      senderMap: { "u1-phone": { userId: "u1", name: "U1" } },
      sharedUserId: "shared",
    },
  })
  assert.equal(cfg.multiUser?.scoping, undefined)
  assert.equal(cfg.multiUser?.sharedUserId, "shared")
})

test("parseConfig — scoping disabled returns no scoping", () => {
  const cfg = parseConfig({
    ...base,
    multiUser: {
      senderMap: { "u1-phone": { userId: "u1", name: "U1" } },
      scoping: {
        enabled: false,
        defaultScope: "private",
        scopes: ["private"],
        roles: {},
        users: {},
      },
    },
  })
  assert.equal(cfg.multiUser?.scoping, undefined)
})

test("parseConfig — empty scopes array throws", () => {
  assert.throws(
    () =>
      parseConfig({
        ...base,
        multiUser: {
          senderMap: { "u1-phone": { userId: "u1", name: "U1" } },
          scoping: {
            enabled: true,
            defaultScope: "private",
            scopes: [],
            roles: {},
            users: {},
          },
        },
      }),
    /scoping\.scopes/,
  )
})

test("parseConfig — defaultScope not in scopes throws", () => {
  assert.throws(
    () =>
      parseConfig({
        ...base,
        multiUser: {
          senderMap: { "u1-phone": { userId: "u1", name: "U1" } },
          scoping: {
            enabled: true,
            defaultScope: "nonexistent",
            scopes: ["private", "family"],
            roles: {},
            users: {},
          },
        },
      }),
    /defaultScope/,
  )
})

test("parseConfig — role canRead with unknown scope throws", () => {
  assert.throws(
    () =>
      parseConfig({
        ...base,
        multiUser: {
          senderMap: { "u1-phone": { userId: "u1", name: "U1" } },
          scoping: {
            enabled: true,
            defaultScope: "private",
            scopes: ["private", "family"],
            roles: {
              weird: { canRead: ["private", "ghost"], defaultWriteScope: "private" },
            },
            users: {},
          },
        },
      }),
    /canRead.*ghost/,
  )
})

test("parseConfig — role defaultWriteScope not in scopes throws", () => {
  assert.throws(
    () =>
      parseConfig({
        ...base,
        multiUser: {
          senderMap: { "u1-phone": { userId: "u1", name: "U1" } },
          scoping: {
            enabled: true,
            defaultScope: "private",
            scopes: ["private", "family"],
            roles: {
              weird: { canRead: ["family"], defaultWriteScope: "nonexistent" },
            },
            users: {},
          },
        },
      }),
    /defaultWriteScope/,
  )
})

test("parseConfig — canWriteScopes with unknown scope throws", () => {
  assert.throws(
    () =>
      parseConfig({
        ...base,
        multiUser: {
          senderMap: { "u1-phone": { userId: "u1", name: "U1" } },
          scoping: {
            enabled: true,
            defaultScope: "private",
            scopes: ["private", "family"],
            roles: {
              weird: {
                canRead: ["*"],
                defaultWriteScope: "private",
                canWriteScopes: ["ghost"],
              },
            },
            users: {},
          },
        },
      }),
    /canWriteScopes.*ghost/,
  )
})

test("parseConfig — user role keying into unknown role throws", () => {
  assert.throws(
    () =>
      parseConfig({
        ...base,
        multiUser: {
          senderMap: { "u1-phone": { userId: "u1", name: "U1" } },
          scoping: {
            enabled: true,
            defaultScope: "private",
            scopes: ["private", "family"],
            roles: {
              parent: { canRead: ["*"], defaultWriteScope: "private" },
            },
            users: { u1: { role: "nonexistent" } },
          },
        },
      }),
    /does not key into scoping\.roles/,
  )
})

test("parseConfig — valid scoping parses", () => {
  const cfg = parseConfig({
    ...base,
    multiUser: {
      senderMap: { "u1-phone": { userId: "u1", name: "U1" } },
      scoping: {
        enabled: true,
        defaultScope: "private",
        scopes: ["private", "family", "parent_only"],
        roles: {
          parent: { canRead: ["*"], defaultWriteScope: "private" },
          kid: { canRead: ["family"], defaultWriteScope: "family" },
        },
        users: {
          u1: { role: "parent" },
        },
        collections: { family: "household" },
        voiceId: { enabled: true, confidenceThreshold: 0.8 },
      },
    },
  })
  assert.equal(cfg.multiUser?.scoping?.enabled, true)
  assert.deepEqual(cfg.multiUser?.scoping?.scopes, ["private", "family", "parent_only"])
  assert.equal(cfg.multiUser?.scoping?.roles.parent?.defaultWriteScope, "private")
  assert.equal(cfg.multiUser?.scoping?.collections?.family, "household")
  assert.equal(cfg.multiUser?.scoping?.voiceId?.confidenceThreshold, 0.8)
})

test("parseConfig — startupOrientation defaults to disabled with sensible values", () => {
  const cfg = parseConfig(base)
  assert.equal(cfg.startupOrientation.enabled, false)
  assert.equal(cfg.startupOrientation.recentDays, 7)
  assert.equal(cfg.startupOrientation.recentLimit, 5)
  assert.equal(cfg.startupOrientation.loopsLimit, 3)
  assert.ok(cfg.startupOrientation.loopsQuery.length > 0)
})

test("parseConfig — startupOrientation accepts overrides", () => {
  const cfg = parseConfig({
    ...base,
    startupOrientation: {
      enabled: true,
      recentDays: 14,
      recentLimit: 3,
      loopsLimit: 5,
      loopsQuery: "custom loops",
    },
  })
  assert.equal(cfg.startupOrientation.enabled, true)
  assert.equal(cfg.startupOrientation.recentDays, 14)
  assert.equal(cfg.startupOrientation.recentLimit, 3)
  assert.equal(cfg.startupOrientation.loopsLimit, 5)
  assert.equal(cfg.startupOrientation.loopsQuery, "custom loops")
})

test("parseConfig — syncMemories boolean true keeps legacy behavior, sectionize defaults on", () => {
  const cfg = parseConfig({ ...base, syncMemories: true })
  assert.equal(cfg.syncMemories, true)
  assert.equal(cfg.syncMemoriesConfig.enabled, true)
  assert.equal(cfg.syncMemoriesConfig.sectionize, true)
  assert.deepEqual(cfg.syncMemoriesConfig.watchPaths, [])
  assert.equal(cfg.syncMemoriesConfig.debounceMs, 2000)
  assert.equal(cfg.syncMemoriesConfig.maxAgeDays, 30)
  assert.deepEqual(cfg.syncMemoriesConfig.ignorePaths, ["dreaming"])
})

test("parseConfig — syncMemories false disables sync", () => {
  const cfg = parseConfig({ ...base, syncMemories: false })
  assert.equal(cfg.syncMemories, false)
  assert.equal(cfg.syncMemoriesConfig.enabled, false)
})

test("parseConfig — syncMemories object form parses and enables by default", () => {
  const cfg = parseConfig({
    ...base,
    syncMemories: {
      sectionize: false,
      watchPaths: ["MEMORY.md", "notes/"],
      debounceMs: 500,
      maxAgeDays: 7,
      ignorePaths: ["dreaming", "scratch"],
    },
  })
  assert.equal(cfg.syncMemories, true) // object without explicit enabled => on
  assert.equal(cfg.syncMemoriesConfig.sectionize, false)
  assert.deepEqual(cfg.syncMemoriesConfig.watchPaths, ["MEMORY.md", "notes/"])
  assert.equal(cfg.syncMemoriesConfig.debounceMs, 500)
  assert.equal(cfg.syncMemoriesConfig.maxAgeDays, 7)
  assert.deepEqual(cfg.syncMemoriesConfig.ignorePaths, ["dreaming", "scratch"])
})

test("parseConfig — syncMemories object with a typo'd key throws", () => {
  assert.throws(
    () => parseConfig({ ...base, syncMemories: { sectionise: true } }),
    /hyperspell\.syncMemories has unknown keys: sectionise/,
  )
})

test("parseConfig — hotBuffer defaults to disabled with safe defaults", () => {
  const cfg = parseConfig(base)
  assert.equal(cfg.hotBuffer.enabled, false)
  assert.equal(cfg.hotBuffer.source, "vault")
  assert.equal(cfg.hotBuffer.writeUser, true)
  assert.equal(cfg.hotBuffer.writeAssistant, true)
})

test("parseConfig — hotBuffer honors explicit settings", () => {
  const cfg = parseConfig({
    ...base,
    hotBuffer: {
      enabled: true,
      source: "vault",
      writeUser: true,
      writeAssistant: false,
    },
  })
  assert.equal(cfg.hotBuffer.enabled, true)
  assert.equal(cfg.hotBuffer.writeAssistant, false)
})

test("parseConfig — hotBuffer with an unknown key throws", () => {
  assert.throws(
    () => parseConfig({ ...base, hotBuffer: { enbaled: true } }),
    /hyperspell\.hotBuffer has unknown keys: enbaled/,
  )
})

test("parseConfig — hotBuffer with an invalid source throws", () => {
  assert.throws(
    () => parseConfig({ ...base, hotBuffer: { source: "nonsense" } }),
    /Invalid source/,
  )
})

test("parseConfig — excludeChannels defaults to empty", () => {
  const cfg = parseConfig(base)
  assert.deepEqual(cfg.excludeChannels, [])
})

test("parseConfig — excludeChannels trims entries and drops empties", () => {
  const cfg = parseConfig({
    ...base,
    excludeChannels: [" 1521620672726438171 ", "", "abc"],
  })
  assert.deepEqual(cfg.excludeChannels, ["1521620672726438171", "abc"])
})

test("parseConfig — non-array excludeChannels falls back to empty", () => {
  const cfg = parseConfig({ ...base, excludeChannels: "123" })
  assert.deepEqual(cfg.excludeChannels, [])
})

test("parseConfig — moodWeatherChance defaults to 0 (mood weather off)", () => {
  assert.equal(parseConfig(base).moodWeatherChance, 0)
})

test("parseConfig — ranking.storyTerms are trimmed, lowercased, deduped; whitespace-only dropped", () => {
  const cfg = parseConfig({
    ...base,
    ranking: { storyTerms: ["  Omuerta ", "omuerta", "", " ", 42, "Lady of Storms"] },
  })
  assert.deepEqual(cfg.ranking.storyTerms, ["omuerta", "42", "lady of storms"])
})

test("parseConfig — non-array ranking.storyTerms falls back to the empty default", () => {
  const cfg = parseConfig({ ...base, ranking: { storyTerms: "omuerta" } })
  assert.deepEqual(cfg.ranking.storyTerms, [])
})
