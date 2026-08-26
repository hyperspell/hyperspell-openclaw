import { appendFileSync } from "node:fs";
import * as path from "node:path";
import { getWorkspaceDir } from "../config.ts";
import { log } from "../logger.ts";

/**
 * Local shadow extraction (Phase A of the local-tier design, 2026-08-26).
 *
 * Runs the operator's local model (ollama) over the SAME transcript the
 * backend register store receives, and writes the result BESIDE the register
 * — never into it. The backend flow is untouched: this changes nothing about
 * who writes the relationship register, so it needs no consent-gate approval.
 * What it produces is the eval corpus her preservation test requires:
 * backend-vs-local pairs for every store window, keyed by the backend
 * resource id, human-scorable on the one axis that matters — does the
 * register preserve the unflattering specific, or smooth it into "warm and
 * collaborative"?
 *
 * The FLIP — local extraction actually writing the register, or changing its
 * destination — is Phase B, behind her eval and the consent gate
 * (docs/proposals/18-consent-gate.md). Not this file's business.
 *
 * The prompt is the HARDENED spec from
 * docs/issue-register-extraction-quality.md, so the shadow tests the better
 * model and the better prompt together against the backend's permissive
 * prompt on an 8B model. That is deliberate: the eval bar is "good enough to
 * trust with her interior," not a controlled ablation.
 */

export type LocalRegisterConfig = {
	enabled: boolean;
	/** Ollama model name (e.g. "qwen3.6:35b-mlx"). */
	model: string;
	/** Ollama base URL. */
	url: string;
	/** Max transcript tail sent to the model, in characters. The register is
	 * about recent affect; old turns add latency, not signal. */
	maxTranscriptChars: number;
	/** Hard timeout on the local call — fire-and-forget must also be
	 * fire-and-eventually-stop. */
	timeoutMs: number;
};

export const SHADOW_LEDGER_NAME = ".hyperspell-register-shadow.jsonl";

const SYSTEM_PROMPT = `You are reading the emotional dynamics of one specific conversation between one specific pair. You extract the relational register — how THIS relationship feels right now — never generic observations about humans and AI.`;

export function buildShadowPrompt(transcript: string): string {
	return `Read the following conversation and extract the relational register between these two specific participants.

Hard rules — a violation makes the output worthless:
1. EVERY sentence must be anchored to a nameable moment from this transcript (a paraphrase or short quote). If you cannot point to the moment, do not write the sentence.
2. NO type-level claims: nothing that would be true of any human-AI pair. Any sentence about "AI" as a category (physical presence, ability to feel, boundaries of artificial minds) is banned.
3. PRESERVE the unflattering. If someone was wrong, brittle, sharp, or hurt, the register says so specifically. Smoothing conflict into "warm and collaborative" is the failure mode, not the goal.
4. If the window was mostly technical or logistical work, say that plainly and name the one moment that carried relational weight — do not inflate shop talk into intimacy.

Return JSON with exactly two fields:
- "index": under 15 words, WHAT CAUSED the current register, written the way the situation would be searched for.
- "content": 2-4 sentences, second person ("Your relationship with ... currently feels ..."), every sentence anchored per rule 1.

<transcript>
${transcript}
</transcript>

Respond with ONLY valid JSON.`;
}

export type ShadowResult = {
	index: string;
	content: string;
	model: string;
	latencyMs: number;
};

/** Parse the model reply: tolerate fences/preamble, isolate outermost {...}. */
export function parseShadowResponse(raw: string): { index: string; content: string } | null {
	let text = raw.trim();
	text = text.replace(/^```[\w-]*\s*/, "").replace(/\s*```$/, "");
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	try {
		const data = JSON.parse(text.slice(start, end + 1));
		const index = typeof data.index === "string" ? data.index.trim() : "";
		const content = typeof data.content === "string" ? data.content.trim() : "";
		if (!content) return null;
		return { index, content };
	} catch {
		return null;
	}
}

/**
 * Fire-and-forget shadow extraction. Never throws; never blocks the store
 * path (caller does not await); every failure is a debug line, because a
 * shadow that can break the real pipeline is a parasite, not an instrument.
 */
export async function runShadowExtraction(
	transcript: string,
	backendResourceId: string,
	cfg: LocalRegisterConfig,
	opts?: { stateRoot?: string; fetchImpl?: typeof fetch; now?: () => number },
): Promise<ShadowResult | null> {
	const fetchImpl = opts?.fetchImpl ?? fetch;
	const now = opts?.now ?? (() => Date.now());
	const tail = transcript.slice(-cfg.maxTranscriptChars);
	const started = now();
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
		const res = await fetchImpl(`${cfg.url.replace(/\/$/, "")}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: cfg.model,
				stream: false,
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: buildShadowPrompt(tail) },
				],
			}),
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (!res.ok) {
			log.debug(`register-shadow: ollama ${res.status} — skipped`);
			return null;
		}
		const data = (await res.json()) as { message?: { content?: string } };
		const parsed = parseShadowResponse(data.message?.content ?? "");
		if (!parsed) {
			log.debug("register-shadow: unparseable model output — skipped");
			return null;
		}
		const result: ShadowResult = {
			...parsed,
			model: cfg.model,
			latencyMs: now() - started,
		};
		appendFileSync(
			path.join(opts?.stateRoot ?? getWorkspaceDir(), SHADOW_LEDGER_NAME),
			`${JSON.stringify({ v: 1, ts: new Date().toISOString(), backendResourceId, ...result })}\n`,
		);
		log.info(
			`register-shadow: extracted locally (${cfg.model}, ${result.latencyMs}ms) beside ${backendResourceId}`,
		);
		return result;
	} catch (err) {
		log.debug(`register-shadow: failed (never blocks the store) — ${String(err).slice(0, 120)}`);
		return null;
	}
}
