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
  assert.deepEqual(cfg.syncMemoriesConfig.watchPaths, [
    { path: "MEMORY.md" },
    { path: "notes/" },
  ])
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

test("parseConfig — watchPaths string entries normalize to { path }", () => {
  const cfg = parseConfig({
    ...base,
    syncMemories: { watchPaths: ["notes/brainstem"] },
  })
  assert.deepEqual(cfg.syncMemoriesConfig.watchPaths, [{ path: "notes/brainstem" }])
})

test("parseConfig — watchPaths object entry keeps source, sanitized to metadata-safe chars", () => {
  const cfg = parseConfig({
    ...base,
    syncMemories: {
      watchPaths: [{ path: "notes/brainstem", source: "brainstem-daily" }],
    },
  })
  assert.deepEqual(cfg.syncMemoriesConfig.watchPaths, [
    { path: "notes/brainstem", source: "brainstem_daily" },
  ])
})

test("parseConfig — watchPaths entry with an unknown key throws", () => {
  assert.throws(
    () =>
      parseConfig({
        ...base,
        syncMemories: {
          watchPaths: [{ path: "notes", sources: "typo" }],
        },
      }),
    /hyperspell\.syncMemories\.watchPaths\[\] has unknown keys: sources/,
  )
})

test("parseConfig — watchPaths entry missing path throws", () => {
  assert.throws(
    () =>
      parseConfig({
        ...base,
        syncMemories: { watchPaths: [{ source: "brainstem_daily" }] },
      }),
    /needs a non-empty path/,
  )
})

test("parseConfig — watchPaths empty-string entry throws", () => {
  assert.throws(
    () => parseConfig({ ...base, syncMemories: { watchPaths: ["  "] } }),
    /needs a non-empty path/,
  )
})

test("parseConfig — watchPaths defaults to empty", () => {
  const cfg = parseConfig({ ...base, syncMemories: {} })
  assert.deepEqual(cfg.syncMemoriesConfig.watchPaths, [])
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

test("parseConfig — hotBuffer speaker labels parse, trim, and default to undefined", () => {
  const cfg = parseConfig({
    ...base,
    hotBuffer: { enabled: true, userLabel: " David ", assistantLabel: "Alinea" },
  })
  assert.equal(cfg.hotBuffer.userLabel, "David")
  assert.equal(cfg.hotBuffer.assistantLabel, "Alinea")

  const bare = parseConfig({ ...base, hotBuffer: { enabled: true } })
  assert.equal(bare.hotBuffer.userLabel, undefined)
  assert.equal(bare.hotBuffer.assistantLabel, undefined)

  // Whitespace-only labels are treated as absent, not as an empty prefix.
  const blank = parseConfig({ ...base, hotBuffer: { enabled: true, userLabel: "  " } })
  assert.equal(blank.hotBuffer.userLabel, undefined)
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

test("parseConfig — quarantineResources defaults to empty", () => {
  const cfg = parseConfig(base)
  assert.deepEqual(cfg.quarantineResources, [])
})

test("parseConfig — quarantineResources trims entries and drops empties", () => {
  const cfg = parseConfig({
    ...base,
    quarantineResources: [" 0471aa5b-2c34-43d0-a810-3bd846076e43 ", "", "bmUWAL0A8ieq9Q"],
  })
  assert.deepEqual(cfg.quarantineResources, [
    "0471aa5b-2c34-43d0-a810-3bd846076e43",
    "bmUWAL0A8ieq9Q",
  ])
})

test("parseConfig — non-array quarantineResources falls back to empty", () => {
  const cfg = parseConfig({ ...base, quarantineResources: "abc" })
  assert.deepEqual(cfg.quarantineResources, [])
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

test("parseConfig — recency fields default when absent", () => {
  const cfg = parseConfig({ ...base, ranking: {} })
  assert.equal(cfg.ranking.recencyHalfLifeDays, 90)
  assert.equal(cfg.ranking.recencyMaxPenalty, 0.1)
  assert.equal(cfg.ranking.recencyCuratedFactor, 0.5)
})

test("parseConfig — recency fields respected when present, clamped when out of range", () => {
  const cfg = parseConfig({
    ...base,
    ranking: { recencyHalfLifeDays: 180, recencyMaxPenalty: 0.05, recencyCuratedFactor: 2 },
  })
  assert.equal(cfg.ranking.recencyHalfLifeDays, 180)
  assert.equal(cfg.ranking.recencyMaxPenalty, 0.05)
  assert.equal(cfg.ranking.recencyCuratedFactor, 1, "factor clamps to 1")
  const neg = parseConfig({
    ...base,
    ranking: { recencyHalfLifeDays: -5, recencyMaxPenalty: -1, recencyCuratedFactor: -0.5 },
  })
  assert.equal(neg.ranking.recencyHalfLifeDays, 0)
  assert.equal(neg.ranking.recencyMaxPenalty, 0)
  assert.equal(neg.ranking.recencyCuratedFactor, 0)
})

test("parseConfig — knowledgeGraph defaults to disabled with sensible values", () => {
  const cfg = parseConfig(base)
  assert.equal(cfg.knowledgeGraph.enabled, false)
  assert.equal(cfg.knowledgeGraph.scanIntervalMinutes, 60)
  assert.equal(cfg.knowledgeGraph.batchSize, 20)
})

test("parseConfig — knowledgeGraph accepts overrides", () => {
  const cfg = parseConfig({
    ...base,
    knowledgeGraph: { enabled: true, batchSize: 50 },
  })
  assert.equal(cfg.knowledgeGraph.enabled, true)
  assert.equal(cfg.knowledgeGraph.batchSize, 50)
  // Unspecified fields keep their defaults.
  assert.equal(cfg.knowledgeGraph.scanIntervalMinutes, 60)
})

test("parseConfig — coverageLog defaults OFF (prompts must not reach disk without opt-in)", () => {
  const cfg = parseConfig(base)
  assert.equal(cfg.coverageLog, false)
})

test("parseConfig — coverageLog is an accepted key and opts in explicitly", () => {
  const cfg = parseConfig({ ...base, coverageLog: true })
  assert.equal(cfg.coverageLog, true)
})

test("parseConfig — sourceWeights absent defaults to empty (neutral no-op)", () => {
  const cfg = parseConfig({ ...base, ranking: {} })
  assert.deepEqual(cfg.ranking.sourceWeights, {})
})

test("parseConfig — sourceWeights keys lowercased, non-numeric values skipped", () => {
  const cfg = parseConfig({
    ...base,
    ranking: { sourceWeights: { Notion: 1.15, slack: "0.8", github: 1.0 } },
  })
  assert.deepEqual(cfg.ranking.sourceWeights, { notion: 1.15, github: 1.0 })
})

test("parseConfig — explicit non-positive sourceWeights throw with the sources-filter pointer", () => {
  for (const bad of [0, -1]) {
    assert.throws(
      () => parseConfig({ ...base, ranking: { sourceWeights: { slack: bad } } }),
      /must be a positive number.*sources.*filter/s,
    )
  }
})

test("parseConfig — dedupThreshold defaults to 0.8, clamps to [0,1]", () => {
  assert.equal(parseConfig({ ...base, ranking: {} }).ranking.dedupThreshold, 0.8)
  assert.equal(
    parseConfig({ ...base, ranking: { dedupThreshold: 0 } }).ranking.dedupThreshold,
    0,
    "0 is a valid explicit off-switch",
  )
  assert.equal(parseConfig({ ...base, ranking: { dedupThreshold: 1.5 } }).ranking.dedupThreshold, 1)
  assert.equal(parseConfig({ ...base, ranking: { dedupThreshold: -1 } }).ranking.dedupThreshold, 0)
})

test("parseConfig — elbow defaults off with documented parameters", () => {
  const cfg = parseConfig({ ...base, ranking: {} })
  assert.deepEqual(cfg.ranking.elbow, {
    enabled: false,
    minResults: 3,
    gapRatio: 2.5,
    minGap: 0.05,
  })
})

test("parseConfig — elbow overrides respected; minResults clamps to >= 2, gapRatio to >= 1", () => {
  const cfg = parseConfig({
    ...base,
    ranking: { elbow: { enabled: true, minResults: 1, gapRatio: 0.5, minGap: 0.08 } },
  })
  assert.equal(cfg.ranking.elbow.enabled, true)
  assert.equal(cfg.ranking.elbow.minResults, 2, "one gap must exist before meanGap is defined")
  assert.equal(cfg.ranking.elbow.gapRatio, 1)
  assert.equal(cfg.ranking.elbow.minGap, 0.08)
})
