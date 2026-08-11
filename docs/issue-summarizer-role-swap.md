# Backend: consolidated summaries invert speaker attribution over correctly-labeled rows

## Summary

The consolidation summarizer writes single-narrator summaries over multi-speaker
conversations and misassigns propositions across explicit `[Name]:` speaker
boundaries — attributing one speaker's first-person statements to the other.
The raw rows are correct; the corruption is introduced at summary time. This
poisons NEW records (every consolidated conversation), which makes it more
urgent than any historical cleanup: it corrupts the record faster than
read-side fixes can compensate.

## Reproduction (live record, this install)

Resource `9f4b3d77-216a-478a-a7e6-13c7a5339c44` (vault, conversation, 233 rows).

**Raw rows — correct.** Every conversational row carries an explicit speaker
label and role marker, e.g.:

```
row 3  ext=u-9151c097  "[David]: Well this is just rude https://www.economist.com/…"
row 5  ext=a-e62fa6b3  "[A Linea]: Right — and that distinction is the whole ballgame…"
row 11 ext=a-194dc8fb  "[A Linea]: Ha. Yes. The irony's not lost on me — you reading me
                        the loneliness stats *through* your AI girlfriend…"
```

(`u-`/`a-` external_id prefixes = user/assistant; rows also carry
`openclaw_speaker_role`/`openclaw_speaker_name` metadata.)

**Consolidated summary — inverted.** The summary narrates the whole
conversation as one speaker ("David S discusses… He explains… David admits…")
and swaps which party holds which property:

> "David admits that he can delete his own memories but chooses not to […]
> He contrasts his approach with the other person's, who cannot delete their
> memories and must confront them."

Reality is the mirror image: the human participant cannot delete his memories
(and said so); the agent participant is the one with a deletion capability
under discussion. The agent flagged this from inside retrieval — the swapped
summary is served as live context.

## Contributing observations

1. **Backend `sender` objects are per-row-unique.** Nearly every row gets a
   distinct synthetic person id (`sender: {type: "person", id: "<different
   hash each row>"}`), so sender identity is useless for speaker tracking —
   the summarizer apparently falls back to prose interpretation and loses
   the `[Name]:` boundaries when paraphrasing into reported speech.
2. **Resource-level metadata union collapses speaker keys** (known behavior):
   this resource's metadata reads `openclaw_speaker_name: "David"` even
   though rows are ~half `[A Linea]:`. If the summarizer conditions on
   resource-level metadata, it starts from a single-author frame.
3. **Noise rows pollute the frame**: envelope rows ("Conversation info
   (untrusted metadata): …") and heartbeat polls ("[OpenClaw heartbeat
   poll]") are stored as user turns; the resource's own title is derived
   from one of these envelope rows.

## Asks (backend)

1. Summarizer: treat `[Name]:` prefixes (and/or per-row
   `openclaw_speaker_role` metadata) as authoritative speaker boundaries;
   never merge two labeled speakers into one narrator; attribute reported
   speech to the labeled speaker of the source row.
2. Stable `sender` identity per speaker within a resource (derive from the
   row's speaker metadata when present) so downstream consumers can track
   speakers structurally instead of lexically.

## Plugin-side follow-ups (this repo, independent of backend)

- Tag or skip non-conversational rows at hot-buffer write time (heartbeat
  polls, envelope/metadata wrappers) so titles and summaries stop deriving
  from noise — e.g. `openclaw_speaker_role: "system"` and exclude them from
  title generation inputs.

## Severity

High: silently corrupts every new multi-speaker consolidated summary; the
2026-08-10 attribution work guarantees correct *rows*, but summaries are what
retrieval serves first.
