import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { HyperspellClient } from "../client.ts";
import { parseConfig } from "../config.ts";
import {
	buildHotBufferHandler,
	buildHotBufferSessionCleanupHandler,
} from "./hot-buffer.ts";

type SentBatch = Array<{
	resourceId: string;
	messageId: string;
	content: string;
}>;

function makeClient() {
	const calls: SentBatch[] = [];
	const optionsList: Array<Record<string, unknown> | undefined> = [];
	const client = {
		async sendMessages(messages: SentBatch, options?: Record<string, unknown>) {
			calls.push(messages);
			optionsList.push(options);
			return { count: messages.length };
		},
	} as unknown as HyperspellClient;
	return { client, calls, optionsList };
}

const cfg = parseConfig({
	apiKey: "k",
	userId: "u1",
	hotBuffer: { enabled: true },
});

test("hot-buffer — writes user and assistant turns with stable ids", async () => {
	const { client, calls } = makeClient();
	const handler = buildHotBufferHandler(client, cfg);
	await handler(
		{
			success: true,
			sessionId: "s1",
			messages: [
				{ role: "user", content: "hello violet-anchor-123" },
				{ role: "assistant", content: "hi there" },
				{ role: "system", content: "ignored" },
			],
		},
		{},
	);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].length, 2);
	assert.equal(calls[0][0].resourceId, "s1");
	assert.equal(calls[0][0].content, "hello violet-anchor-123");
	// distinct ids per role
	assert.notEqual(calls[0][0].messageId, calls[0][1].messageId);
});

test("hot-buffer — tags rows with origin metadata (source, session, channel)", async () => {
	// Metadata on POST /messages is retrievable + filterable since the #1921
	// backend fix (verified live 2026-07-02, docs/filter-dialect-test.mjs).
	// Tagging by origin lets retrieval and cleanup filter hot rows precisely;
	// the {openclaw_source:{$ne:"agent_end"}} exclude keeps "hot_buffer" rows.
	const { client, calls, optionsList } = makeClient();
	const handler = buildHotBufferHandler(client, cfg);
	await handler(
		{
			success: true,
			messages: [{ role: "user", content: "tag me" }],
		},
		{ sessionId: "s-tag", channelId: "chan-9" },
	);
	assert.equal(calls.length, 1);
	assert.deepEqual((optionsList[0] as { metadata?: unknown }).metadata, {
		openclaw_source: "hot_buffer",
		openclaw_session_id: "s-tag",
		openclaw_channel_id: "chan-9",
	});
});

test("hot-buffer — omits channel tag when ctx has no channelId", async () => {
	const { client, calls, optionsList } = makeClient();
	const handler = buildHotBufferHandler(client, cfg);
	await handler(
		{
			success: true,
			messages: [{ role: "user", content: "no channel" }],
		},
		{ sessionId: "s-nochan" },
	);
	assert.equal(calls.length, 1);
	assert.deepEqual((optionsList[0] as { metadata?: unknown }).metadata, {
		openclaw_source: "hot_buffer",
		openclaw_session_id: "s-nochan",
	});
});

test("hot-buffer — resourceId comes from ctx.sessionId (agent_end event has none)", async () => {
	// Regression for issue #42: PluginHookAgentEndEvent carries no sessionId —
	// it lives on the hook ctx. Reading event.sessionId yielded a fresh random
	// resourceId every turn. The realistic shape is: no sessionId on the event,
	// sessionId on ctx.
	const { client, calls } = makeClient();
	const handler = buildHotBufferHandler(client, cfg);
	await handler(
		{ success: true, messages: [{ role: "user", content: "anchor" }] },
		{ sessionId: "ctx-sess" },
	);
	assert.equal(calls[0][0].resourceId, "ctx-sess");
});

test("hot-buffer — ctx.sessionId takes precedence over event.sessionId", async () => {
	const { client, calls } = makeClient();
	const handler = buildHotBufferHandler(client, cfg);
	await handler(
		{ success: true, sessionId: "evt", messages: [{ role: "user", content: "x" }] },
		{ sessionId: "ctx-wins" },
	);
	assert.equal(calls[0][0].resourceId, "ctx-wins");
});

test("hot-buffer — stable ctx.sessionId dedups across turns (no whole-transcript re-post)", async () => {
	const { client, calls } = makeClient();
	const handler = buildHotBufferHandler(client, cfg);
	const ctx = { sessionId: "stable-sess" };
	await handler(
		{ success: true, messages: [{ role: "user", content: "turn-1" }] },
		ctx,
	);
	// agent_end fires again with the full history + one new line, same ctx.
	await handler(
		{
			success: true,
			messages: [
				{ role: "user", content: "turn-1" },
				{ role: "assistant", content: "reply-1" },
				{ role: "user", content: "turn-2" },
			],
		},
		ctx,
	);
	// Only the 2 NEW lines are sent the second turn — not the whole transcript.
	assert.equal(calls.length, 2);
	assert.equal(calls[1].length, 2);
	assert.deepEqual(
		calls[1].map((m) => m.content),
		["reply-1", "turn-2"],
	);
	// All rows share the stable resourceId.
	for (const batch of calls)
		for (const m of batch) assert.equal(m.resourceId, "stable-sess");
});

test("hot-buffer — idempotent: re-firing the same turn sends nothing new", async () => {
	const { client, calls } = makeClient();
	const handler = buildHotBufferHandler(client, cfg);
	const event = {
		success: true,
		sessionId: "s2",
		messages: [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "reply" },
		],
	};
	await handler(event, {});
	// agent_end fires again next turn with the full history + one new pair
	await handler(
		{
			...event,
			messages: [
				...event.messages,
				{ role: "user", content: "second" },
				{ role: "assistant", content: "reply two" },
			],
		},
		{},
	);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].length, 2); // first pair
	assert.equal(calls[1].length, 2); // only the new pair
	assert.deepEqual(
		calls[1].map((m) => m.content),
		["second", "reply two"],
	);
});

test("hot-buffer — writeAssistant=false skips assistant lines", async () => {
	const { client, calls } = makeClient();
	const userOnly = parseConfig({
		apiKey: "k",
		userId: "u1",
		hotBuffer: { enabled: true, writeAssistant: false },
	});
	const handler = buildHotBufferHandler(client, userOnly);
	await handler(
		{
			success: true,
			sessionId: "s3",
			messages: [
				{ role: "user", content: "u" },
				{ role: "assistant", content: "a" },
			],
		},
		{},
	);
	assert.equal(calls[0].length, 1);
	assert.equal(calls[0][0].content, "u");
});

test("hot-buffer — skips when agent ended with error", async () => {
	const { client, calls } = makeClient();
	const handler = buildHotBufferHandler(client, cfg);
	await handler(
		{ success: false, sessionId: "s4", messages: [{ role: "user", content: "x" }] },
		{},
	);
	assert.equal(calls.length, 0);
});

test("hot-buffer — skips when no userId resolves", async () => {
	const { client, calls } = makeClient();
	const noUser = parseConfig({ apiKey: "k", hotBuffer: { enabled: true } });
	const handler = buildHotBufferHandler(client, noUser);
	await handler(
		{ success: true, sessionId: "s5", messages: [{ role: "user", content: "x" }] },
		{},
	);
	assert.equal(calls.length, 0);
});

test("hot-buffer — truncates oversize content to the 512k limit", async () => {
	const { client, calls } = makeClient();
	const handler = buildHotBufferHandler(client, cfg);
	const big = "a".repeat(600_000);
	await handler(
		{ success: true, sessionId: "s6", messages: [{ role: "user", content: big }] },
		{},
	);
	assert.equal(calls[0][0].content.length, 512_000);
});

test("hot-buffer — strips injected context wrappers before writing", async () => {
	const { client, calls } = makeClient();
	const handler = buildHotBufferHandler(client, cfg);
	await handler(
		{
			success: true,
			sessionId: "s7",
			messages: [
				{
					role: "user",
					content:
						"<hyperspell-context>\ninjected memories\n</hyperspell-context>\nreal question",
				},
			],
		},
		{},
	);
	assert.equal(calls[0][0].content, "real question");
});

test("hot-buffer — session cleanup lets ids be re-sent in a fresh run", async () => {
	const { client, calls } = makeClient();
	const handler = buildHotBufferHandler(client, cfg);
	const cleanup = buildHotBufferSessionCleanupHandler();
	const event = {
		success: true,
		sessionId: "s8",
		messages: [{ role: "user", content: "same" }],
	};
	await handler(event, {});
	cleanup({ sessionId: "s8" });
	await handler(event, {});
	assert.equal(calls.length, 2);
});
