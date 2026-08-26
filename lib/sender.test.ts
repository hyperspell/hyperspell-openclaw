import assert from "node:assert/strict"
import { test } from "node:test"
import type { HyperspellConfig } from "../config.ts"
import { DEFAULT_RANKING } from "./ranking.ts"
import {
  buildScopeFilter,
  getCanReadScopes,
  getDefaultWriteScope,
  resolveRole,
  resolveUser,
  routeWrite,
} from "./sender.ts"

function cfg(overrides: Partial<HyperspellConfig["multiUser"]> = {}): HyperspellConfig {
  return {
    apiKey: "test",
    autoContext: false,
    autoTrace: { enabled: false, extract: ["procedure"] },
    hotBuffer: { enabled: false, source: "vault", writeUser: true, writeAssistant: true },
    emotionalContext: false,
    moodWeatherChance: 0,
    registerSenders: [],
    localRegisterShadow: { enabled: false, model: "m", url: "http://x", maxTranscriptChars: 24000, timeoutMs: 300000 },
    excludeChannels: [],
    quarantineResources: [],
    syncMemories: false,
    syncMemoriesConfig: {
      enabled: false,
      sectionize: true,
      watchPaths: [],
      debounceMs: 2000,
      maxAgeDays: 30,
      ignorePaths: ["dreaming"],
    },
    sources: [],
    maxResults: 5,
    relevanceThreshold: 0.6,
    ranking: DEFAULT_RANKING,
    coverageLog: false,
    debug: false,
    knowledgeGraph: { enabled: false, scanIntervalMinutes: 60, batchSize: 20 },
    startupOrientation: {
      enabled: false,
      recentDays: 7,
      recentLimit: 5,
      loopsLimit: 3,
      loopsQuery: "open tasks",
    },
    multiUser: overrides.scoping
      ? {
          sharedUserId: "shared",
          includeSharedInSearch: true,
          senderMap: overrides.senderMap ?? {},
          scoping: overrides.scoping,
        }
      : undefined,
  }
}

test("buildScopeFilter — wildcard returns undefined", () => {
  assert.equal(buildScopeFilter(["*"], "u1"), undefined)
})

test("buildScopeFilter — empty returns match-nothing filter (not undefined)", () => {
  const f = buildScopeFilter([], "u1")
  assert.deepEqual(f, { openclaw_scope: "__never__" })
})

test("buildScopeFilter — single named scope collapses $or", () => {
  const f = buildScopeFilter(["family"], "u1")
  assert.deepEqual(f, { openclaw_scope: { $in: ["family"] } })
})

test("buildScopeFilter — multiple named scopes", () => {
  const f = buildScopeFilter(["family", "kid_shared"], "u1")
  assert.deepEqual(f, { openclaw_scope: { $in: ["family", "kid_shared"] } })
})

test("buildScopeFilter — scopes plus self produces $or", () => {
  const f = buildScopeFilter(["family", "self"], "u1")
  assert.deepEqual(f, {
    $or: [
      { openclaw_scope: { $in: ["family"] } },
      { openclaw_user: "u1" },
    ],
  })
})

test("buildScopeFilter — hyphenated scope normalized in metadata", () => {
  const f = buildScopeFilter(["parent-only"], "u1")
  assert.deepEqual(f, { openclaw_scope: { $in: ["parent_only"] } })
})

test("buildScopeFilter — self only (no named scopes)", () => {
  const f = buildScopeFilter(["self"], "u1")
  assert.deepEqual(f, { openclaw_user: "u1" })
})

test("buildScopeFilter — self only with empty userId → match-nothing", () => {
  const f = buildScopeFilter(["self"], "")
  // Empty userId cannot build a self clause; no named scopes either → match-nothing
  assert.deepEqual(f, { openclaw_scope: "__never__" })
})

test("getCanReadScopes — scoping absent returns wildcard", () => {
  const c = cfg()
  const canRead = getCanReadScopes(
    { userId: "u1", name: "U1", resolved: true },
    c,
  )
  assert.deepEqual(canRead, ["*"])
})

test("getCanReadScopes — role from scoping.users", () => {
  const c = cfg({
    senderMap: { "u1-phone": { userId: "u1", name: "U1" } },
    scoping: {
      enabled: true,
      defaultScope: "private",
      scopes: ["private", "family"],
      roles: {
        kid: { canRead: ["family"], defaultWriteScope: "family" },
      },
      users: { u1: { role: "kid" } },
    },
  })
  const canRead = getCanReadScopes(
    { userId: "u1", name: "U1", resolved: true },
    c,
  )
  assert.deepEqual(canRead, ["family"])
})

test("getCanReadScopes — missing role returns empty (no access)", () => {
  const c = cfg({
    senderMap: { "u1-phone": { userId: "u1", name: "U1" } },
    scoping: {
      enabled: true,
      defaultScope: "private",
      scopes: ["private", "family"],
      roles: {
        kid: { canRead: ["family"], defaultWriteScope: "family" },
      },
      users: {}, // u1 has no role assignment
    },
  })
  const canRead = getCanReadScopes(
    { userId: "u1", name: "U1", resolved: true },
    c,
  )
  assert.deepEqual(canRead, [])
})

test("getDefaultWriteScope — role default wins", () => {
  const c = cfg({
    senderMap: { "u1-phone": { userId: "u1", name: "U1" } },
    scoping: {
      enabled: true,
      defaultScope: "private",
      scopes: ["private", "family"],
      roles: {
        kid: { canRead: ["family"], defaultWriteScope: "family" },
      },
      users: { u1: { role: "kid" } },
    },
  })
  const scope = getDefaultWriteScope(
    { userId: "u1", name: "U1", resolved: true },
    c,
  )
  assert.equal(scope, "family")
})

test("getDefaultWriteScope — falls back to global default when no role", () => {
  const c = cfg({
    senderMap: { "u1-phone": { userId: "u1", name: "U1" } },
    scoping: {
      enabled: true,
      defaultScope: "private",
      scopes: ["private", "family"],
      roles: {},
      users: {},
    },
  })
  const scope = getDefaultWriteScope(
    { userId: "u1", name: "U1", resolved: true },
    c,
  )
  assert.equal(scope, "private")
})

test("getDefaultWriteScope — profile-level role override", () => {
  const c = cfg({
    senderMap: { "u1-phone": { userId: "u1", name: "U1", role: "parent" } },
    scoping: {
      enabled: true,
      defaultScope: "private",
      scopes: ["private", "family"],
      roles: {
        parent: { canRead: ["*"], defaultWriteScope: "private" },
        kid: { canRead: ["family"], defaultWriteScope: "family" },
      },
      users: { u1: { role: "kid" } }, // users table says kid but profile override is parent
    },
  })
  const scope = getDefaultWriteScope(
    { userId: "u1", name: "U1", resolved: true, role: "parent" },
    c,
  )
  assert.equal(scope, "private")
})

test("resolveRole — returns undefined when scoping absent", () => {
  const c = cfg()
  const role = resolveRole(
    { userId: "u1", name: "U1", resolved: true },
    c,
  )
  assert.equal(role, undefined)
})

test("routeWrite — private goes to user's own space", () => {
  const c = cfg({
    senderMap: { "u1-phone": { userId: "u1", name: "U1" } },
    scoping: {
      enabled: true,
      defaultScope: "private",
      scopes: ["private", "family"],
      roles: { kid: { canRead: ["family"], defaultWriteScope: "family" } },
      users: { u1: { role: "kid" } },
    },
  })
  const r = routeWrite(
    { userId: "u1", name: "U1", resolved: true },
    "private",
    c,
  )
  assert.deepEqual(r, { userId: "u1", collection: undefined })
})

test("routeWrite — non-private goes to sharedUserId with optional collection", () => {
  const c = cfg({
    senderMap: { "u1-phone": { userId: "u1", name: "U1" } },
    scoping: {
      enabled: true,
      defaultScope: "private",
      scopes: ["private", "family"],
      roles: { kid: { canRead: ["family"], defaultWriteScope: "family" } },
      users: { u1: { role: "kid" } },
      collections: { family: "household-shared" },
    },
  })
  const r = routeWrite(
    { userId: "u1", name: "U1", resolved: true },
    "family",
    c,
  )
  assert.deepEqual(r, { userId: "shared", collection: "household-shared" })
})

// resolveUser — single-user mode (issue #59)

function singleUserCfg(userId = "alinea"): HyperspellConfig {
  return {
    apiKey: "test",
    autoContext: false,
    autoTrace: { enabled: false, extract: ["procedure"] },
    hotBuffer: { enabled: false, source: "vault", writeUser: true, writeAssistant: true },
    emotionalContext: false,
    moodWeatherChance: 0,
    registerSenders: [],
    localRegisterShadow: { enabled: false, model: "m", url: "http://x", maxTranscriptChars: 24000, timeoutMs: 300000 },
    excludeChannels: [],
    quarantineResources: [],
    syncMemories: false,
    syncMemoriesConfig: {
      enabled: false,
      sectionize: true,
      watchPaths: [],
      debounceMs: 2000,
      maxAgeDays: 30,
      ignorePaths: ["dreaming"],
    },
    sources: [],
    maxResults: 5,
    relevanceThreshold: 0.6,
    ranking: DEFAULT_RANKING,
    coverageLog: false,
    debug: false,
    knowledgeGraph: { enabled: false, scanIntervalMinutes: 60, batchSize: 20 },
    startupOrientation: {
      enabled: false,
      recentDays: 7,
      recentLimit: 5,
      loopsLimit: 3,
      loopsQuery: "open tasks",
    },
    userId,
    multiUser: undefined,
  }
}

test("resolveUser — single-user: resolved is false (static default, not a matched sender)", () => {
  const r = resolveUser(undefined, singleUserCfg())
  assert.equal(r?.resolved, false)
  assert.equal(r?.userId, "alinea")
})

test("resolveUser — single-user: name falls back to cfg.userId when no envelope sender", () => {
  const r = resolveUser(undefined, singleUserCfg())
  assert.equal(r?.name, "alinea")
})

test("resolveUser — single-user: name uses ctx.sender from envelope when present", () => {
  const r = resolveUser({ sender: "David S" }, singleUserCfg())
  assert.equal(r?.userId, "alinea")
  assert.equal(r?.name, "David S")
  assert.equal(r?.resolved, false)
})

test("resolveUser — single-user: name uses ctx.username when sender absent", () => {
  const r = resolveUser({ username: "dithilli" }, singleUserCfg())
  assert.equal(r?.name, "dithilli")
})

test("resolveUser — single-user: ctx.sender takes precedence over ctx.username", () => {
  const r = resolveUser({ sender: "David S", username: "dithilli" }, singleUserCfg())
  assert.equal(r?.name, "David S")
})

test("resolveUser — no userId configured returns undefined", () => {
  const c = singleUserCfg("")
  const r = resolveUser(undefined, c)
  assert.equal(r, undefined)
})
