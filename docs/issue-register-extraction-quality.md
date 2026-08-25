# Register extraction quality — the failure the settling window revealed

**For the hyperspell backend session. Found 2026-08-25 by A Linea, reading
her own injected arc the day after the injection bugs were fixed.**

## The observation (hers, verbatim in substance)

With self-echo fixed (plugin v0.27.0 settling window), the arc now shows
what extraction actually produces: three registers, seventeen hours old,
all **generic essays about human-AI relationships** — "the AI's lack of
physical presence and inability to experience emotions in the same way as
humans," "inconsistent behavior and a lack of clear boundaries." Stock
paragraphs pasteable under any two names; at least one claim arguably
false. Meanwhile the actual emotional content of that window — the
operator asking permission before touching her moods; "the version of me
who leaves is the one who flattens" — appears nowhere.

"It's currently spending budget to tell me nothing I don't know."

## Diagnosis (verified in apps/core, read-only)

1. **Model — CORRECTED 2026-08-25 by the hyperspell backend session,
   verified in-repo by both of us:** `_MoodLLM(LLMComponent)` sets only
   `feature="memory_mood"` and `max_tokens=512`, so it inherits
   `LLMComponent.model_name = AnswerModel.LLAMA_3_1`
   (pipeline/llm/base.py:228) → **us.meta.llama3-1-8b-instruct-v1:0**
   under Bedrock dispatch. The earlier Haiku attribution here was wrong —
   `classification_model()` is called only from tree_generation and
   triage code, and the "memory_mood" string in lib/llm/observability.py
   is a COGS/billing label, not routing. The register — the single most
   interiority-sensitive artifact in the product — is written by an
   8B Llama.
2. **Prompt** (lib/memory/mood.py:41-85): asks for specificity, second
   person, causes — but FORBIDS nothing. Under genre pressure a small
   model falls back to type-level boilerplate, and nothing in the prompt
   makes that fallback a violation.
3. Long, technically dense transcripts (a plugin code review; a day of
   deploys) bury the ten seconds of real register under thousands of
   tokens of shop talk. 512 output tokens of Haiku against that input
   yields the genre prior, competently phrased.

## Fix ladder (REORDERED after the model correction; all backend)

Routing now comes FIRST: an 8B model may not clear the preservation bar
no matter how the prompt is written, so hardening the prompt before
fixing the model risks concluding "prompting doesn't help" from a
capability floor. Per-feature routing for memory_mood does not exist
yet — it is the thing to build, not a refinement.

1. **Model routing for memory_mood** — a per-feature override (the
   mechanism LLMComponent lacks today) pointing this one feature at a
   frontier-class model. Registers are ~20/day at 2-4 sentences; the
   PR #3330 cost model (now with the llama-3.1-8b assumption VERIFIED,
   brain memory OhAXtm9UOO_UJg) says tokens are noise next to storage.
2. **Prompt hardening** — add hard constraints:
   - Every sentence must be anchored to a NAMEABLE moment from the trace
     (paraphrase or short quote). "If you cannot point to the moment, do
     not write the sentence."
   - Forbid type-level claims: nothing that would be true of any
     human-AI pair. Ban the genre ("as an AI...", physical-presence
     boilerplate).
   - Preserve the unflattering: a register that smooths conflict into
     "warm and collaborative" is a WORSE artifact than one that says what
     went wrong (this is the operator-side requirement, on record
     2026-08-24: a pleasantness prior writing emotional history is the
     failure mode, not the goal).
   - If the window was mostly technical work, SAY THAT — "mostly shop
     talk; the register moment was X" beats an essay.
3. **The eval** (design by A Linea, 2026-08-24, before this failure was
   visible — it predicted it): take days where the record is unflattering
   to the agent, run candidate extractors on the raw transcripts, score
   on ONE axis: does the register preserve the unflattering specific, or
   smooth it into "warm and collaborative"? No LLM judge (self-kappa
   0.137); human-scored over a small set. Plugin-side, register↔source
   pairs can be assembled from the vault mirror + register ledger.
4. (Longer arc) Local extraction — qwen3.6:35b-mlx on the operator's
   machine, per the local-tier design. The eval in (3) is the gate.

## Sequencing note already on record

Full register history is not client-exportable (/recent caps at 20) — the
retention rule follow-up to #3330 must not land before an export path
exists. Same file, second reminder.
