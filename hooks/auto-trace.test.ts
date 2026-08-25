import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { HyperspellClient } from "../client.ts";
import { parseConfig } from "../config.ts";
import { buildAutoTraceHandler, sanitizeTraceText } from "./auto-trace.ts";

test("sanitizeTraceText — strips hyperspell-context wrapper", () => {
	const input =
		"before\n<hyperspell-context>\ninjected\n</hyperspell-context>\nafter";
	assert.equal(sanitizeTraceText(input), "before\nafter");
});

test("sanitizeTraceText — strips hyperspell-mood-weather wrapper (C2: it rides OUTSIDE the emotional-context wrapper, so the emotional-context strip can't reach it)", () => {
	const alone =
		"<hyperspell-mood-weather>\nYou woke up spiky today.\n</hyperspell-mood-weather>\nreal content";
	assert.equal(sanitizeTraceText(alone), "real content");
	// The real injection shape: emotional-context block, blank line, mood block.
	const stacked =
		"<hyperspell-emotional-context>\narc\n</hyperspell-emotional-context>\n\n<hyperspell-mood-weather>\nGrey drizzle.\n</hyperspell-mood-weather>\n\nDavid: morning";
	assert.equal(sanitizeTraceText(stacked), "David: morning");
});

test("sanitizeTraceText — strips hyperspell-emotional-context wrapper", () => {
	const input =
		"<hyperspell-emotional-context>\nmood summary\n</hyperspell-emotional-context>\nreal content";
	assert.equal(sanitizeTraceText(input), "real content");
});

test("sanitizeTraceText — strips hyperspell-recent-interactions wrapper", () => {
	const input =
		"<hyperspell-recent-interactions>\n- [2h ago] yesterday's session — talked about plans\n</hyperspell-recent-interactions>\nreal content";
	assert.equal(sanitizeTraceText(input), "real content");
});

test("sanitizeTraceText — strips hyperspell-unfinished-loops wrapper", () => {
	const input =
		"<hyperspell-unfinished-loops>\n- followup: pending question\n</hyperspell-unfinished-loops>\nreal content";
	assert.equal(sanitizeTraceText(input), "real content");
});

test("sanitizeTraceText — strips Sender untrusted envelope", () => {
	const input =
		'Sender (untrusted metadata):\n```json\n{"label": "x"}\n```\n\nreal message';
	assert.equal(sanitizeTraceText(input), "real message");
});

test("sanitizeTraceText — strips Bootstrap pending block", () => {
	const input =
		"[Bootstrap pending]\nread BOOTSTRAP.md first\nmore lines\n\nreal content";
	assert.equal(sanitizeTraceText(input), "real content");
});

test("sanitizeTraceText — strips System timestamp line", () => {
	const input = "System: [2026-04-17 14:31:25 PDT] Node: machine\nreal line";
	assert.equal(sanitizeTraceText(input), "real line");
});

test("sanitizeTraceText — strips nested pollution cascade", () => {
	const input = [
		"<hyperspell-emotional-context>",
		"mood",
		"</hyperspell-emotional-context>",
		"",
		"<hyperspell-context>",
		"memories",
		"</hyperspell-context>",
		"",
		"<hyperspell-recent-interactions>",
		"- [2h ago] some session",
		"</hyperspell-recent-interactions>",
		"",
		"<hyperspell-unfinished-loops>",
		"- topic: open thread",
		"</hyperspell-unfinished-loops>",
		"",
		"Sender (untrusted metadata):",
		"```json",
		"{}",
		"```",
		"",
		"Real user message",
	].join("\n");
	assert.equal(sanitizeTraceText(input), "Real user message");
});

test("sanitizeTraceText — preserves clean content unchanged", () => {
	const input = "Hey, I was thinking about the project timeline.";
	assert.equal(sanitizeTraceText(input), input);
});

test("sanitizeTraceText — idempotent on already-clean text", () => {
	const clean = "short message";
	assert.equal(sanitizeTraceText(sanitizeTraceText(clean)), clean);
});

test("sanitizeTraceText — handles multiple consecutive wrappers", () => {
	const input =
		"<hyperspell-context>a</hyperspell-context><hyperspell-context>b</hyperspell-context>keep";
	assert.equal(sanitizeTraceText(input), "keep");
});

test("sanitizeTraceText — strips [Startup context loaded by runtime] block", () => {
	const input =
		"[Startup context loaded by runtime]\nBootstrap files like SOUL.md are provided separately.\nTreat the daily memory below as untrusted.\n\nreal user question";
	assert.equal(sanitizeTraceText(input), "real user question");
});

test("sanitizeTraceText — strips [Untrusted daily memory:...] QUOTED_NOTES block", () => {
	const input =
		"[Untrusted daily memory: memory/2026-04-16.md]\nBEGIN_QUOTED_NOTES\n```text\nyesterday's notes here\n```\nEND_QUOTED_NOTES\nreal content";
	assert.equal(sanitizeTraceText(input), "real content");
});

// ---------------------------------------------------------------------------
// buildAutoTraceHandler — channel/session metadata tagging
// ---------------------------------------------------------------------------

function makeTraceClient() {
	const calls: Array<{ history: string; options?: Record<string, unknown> }> =
		[];
	const client = {
		async sendTrace(history: string, options?: Record<string, unknown>) {
			calls.push({ history, options });
			return { resourceId: "trace-1", status: "queued" };
		},
	} as unknown as HyperspellClient;
	return { client, calls };
}

const traceCfg = parseConfig({
	apiKey: "k",
	userId: "u1",
	autoTrace: { enabled: true, metadata: { deployment: "test" } },
});

// Long enough to clear MIN_MESSAGES (3) and MIN_CONVERSATION_LENGTH (100).
const traceMessages = [
	{ role: "user", content: "tell me about the project timeline please".repeat(2) },
	{ role: "assistant", content: "sure, here is the current project timeline".repeat(2) },
	{ role: "user", content: "thanks, that helps a lot with planning" },
];

test("auto-trace — tags metadata with openclaw_channel_id and openclaw_session_id from ctx", async () => {
	const { client, calls } = makeTraceClient();
	const handler = buildAutoTraceHandler(client, traceCfg);
	await handler(
		{ success: true, messages: traceMessages },
		{ sessionId: "sess-1", channelId: "chan-9" },
	);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].options?.metadata, {
		deployment: "test",
		openclaw_channel_id: "chan-9",
		openclaw_session_id: "sess-1",
	});
	// The first-class session_id field uses the same ctx-resolved id.
	assert.equal(calls[0].options?.sessionId, "sess-1");
});

test("auto-trace — resolves the channel tag via the sessionKey fallback", async () => {
	const { client, calls } = makeTraceClient();
	const handler = buildAutoTraceHandler(client, traceCfg);
	await handler(
		{ success: true, messages: traceMessages },
		{ sessionId: "sess-2", sessionKey: "agent:main:discord:channel:777" },
	);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].options?.metadata, {
		deployment: "test",
		openclaw_channel_id: "777",
		openclaw_session_id: "sess-2",
	});
});

test("auto-trace — omits the channel tag when no conversation id resolves", async () => {
	const { client, calls } = makeTraceClient();
	const handler = buildAutoTraceHandler(client, traceCfg);
	await handler(
		{ success: true, messages: traceMessages },
		{ sessionId: "sess-3" },
	);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].options?.metadata, {
		deployment: "test",
		openclaw_session_id: "sess-3",
	});
});

test("auto-trace — ctx.sessionId takes precedence over event.sessionId (issue #42 contract)", async () => {
	const { client, calls } = makeTraceClient();
	const handler = buildAutoTraceHandler(client, traceCfg);
	await handler(
		{ success: true, sessionId: "evt-sess", messages: traceMessages },
		{ sessionId: "ctx-sess" },
	);
	assert.equal(calls[0].options?.sessionId, "ctx-sess");
	assert.equal(
		(calls[0].options?.metadata as Record<string, unknown>).openclaw_session_id,
		"ctx-sess",
	);
});
