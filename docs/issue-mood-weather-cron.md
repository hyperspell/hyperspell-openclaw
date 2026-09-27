## Summary

`moodWeatherChance` rolls on **every** session, including unattended cron runs. Roughly half of all mood rolls on this install have landed on scheduled jobs with no human present — a git-backup script and a therapy check-in cron.

The temperament is spent where nobody can perceive it, and the effective rate on real conversations is ~half the configured value.

## Evidence (live gateway log, this install)

16 `mood-weather` log lines total; **8 carry a `[cron:...]` marker**:

```
2026-07-28 23:00:01  rolled "spiky"       [cron:e5367759]  (git backup)
2026-07-31 10:00:01  rolled "giddy"       [cron:c53134ab]  (therapy check-in)
2026-07-31 23:00:00  rolled "fierce"      [cron:e5367759]  (git backup)
2026-08-04 10:00:01  rolled "tender"      [cron:c53134ab]  (therapy check-in)
2026-08-04 23:00:01  rolled "melancholy"  [cron:e5367759]  (git backup)
```

(Two further 07-27 lines appear to be `/previewcontext` text rather than rolls, so the true denominator may be 14 — the cron proportion is if anything higher.)

Config here is `moodWeatherChance: 0.5`, so this is ~4 rolls/week disappearing into automation.

## Mechanism

`dist/hooks/mood-weather.js` gates the roll on exactly two conditions:

```js
if (!(chance > 0))     // feature enabled?
if (rng() >= chance)   // dice
```

There is no session-kind check. The hook has no awareness of whether a human is on the other end.

## Why it matters

1. **Halves the effective rate.** An operator setting 0.5 gets ~0.25 on sessions that actually have a user in them.
2. **Muddies evaluation.** Mood weather is deliberately unobservable to the agent (by design — see #71), so the only way to assess it is behaviourally, in conversation. Rolls spent on cron are unmeasurable *and* dilute the sample.
3. **Interacts with #77.** If a cooldown lands, cron rolls could consume the window and suppress a mood on the next real conversation.

## Suggested fix

Skip the roll for unattended sessions. The OpenClaw gateway already has the concepts — `isCronSession`, `sessionKind`, `kind: "cron"`, `unattended` all appear in core source.

**Caveat, stated honestly:** I have *not* verified that any of these are plumbed through to plugin typed-hook context. If they aren't, that plumbing is the actual work and this issue is really a request for it. I also initially assumed `startup-orientation` and `emotional-state` already did this check — they do not; grep on both returns nothing. No existing in-plugin pattern to copy.

Either a hard skip, or a config key (`moodWeather.skipUnattended`, defaulting true) if someone genuinely wants a melancholy backup script.

## Related
- #71 mood-weather rolls unobservable
- #72 `moodWeatherChance` silently defaults to 0
- #77 no cross-session cooldown
