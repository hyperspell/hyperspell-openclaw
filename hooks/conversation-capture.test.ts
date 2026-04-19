import { describe, expect, it, vi } from "vitest";
import type { HyperspellClient } from "../client.ts";
import type { HyperspellConfig } from "../config.ts";
import { buildConversationCaptureHandler } from "./conversation-capture.ts";

const baseConfig: HyperspellConfig = {
	apiKey: "test-key",
	userId: "user@test.com",
	autoContext: true,
	syncMemories: false,
	captureConversations: true,
	sources: [],
	maxResults: 10,
	debug: false,
	knowledgeGraph: { enabled: false, scanIntervalMinutes: 60, batchSize: 20 },
};

function makeFakeClient() {
	const addMemory = vi.fn().mockResolvedValue({ resourceId: "stored_id" });
	const client = { addMemory } as unknown as HyperspellClient;
	return { client, addMemory };
}

describe("buildConversationCaptureHandler", () => {
	it("captures the latest user+assistant turn to the openclaw_conversations collection", async () => {
		const { client, addMemory } = makeFakeClient();
		const handler = buildConversationCaptureHandler(client, baseConfig);

		await handler(
			{
				messages: [
					{ role: "user", content: "what's the weather?" },
					{ role: "assistant", content: "it's sunny" },
				],
				success: true,
				durationMs: 150,
			},
			{ sessionKey: "main:session-abc" },
		);

		expect(addMemory).toHaveBeenCalledTimes(1);
		const [text, opts] = addMemory.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(text).toContain("User: what's the weather?");
		expect(text).toContain("Assistant: it's sunny");
		expect(opts.collection).toBe("openclaw_conversations");
		expect(typeof opts.resourceId).toBe("string");
		expect((opts.resourceId as string).length).toBeGreaterThan(0);
		const metadata = opts.metadata as Record<string, unknown>;
		expect(metadata.openclaw_source).toBe("conversation");
		expect(metadata.session_id).toBe("main:session-abc");
	});

	it("skips capture when the turn failed (success=false)", async () => {
		const { client, addMemory } = makeFakeClient();
		const handler = buildConversationCaptureHandler(client, baseConfig);

		await handler(
			{
				messages: [
					{ role: "user", content: "hi" },
					{ role: "assistant", content: "hello" },
				],
				success: false,
				error: "prompt timed out",
			},
			{ sessionKey: "main:session-abc" },
		);

		expect(addMemory).not.toHaveBeenCalled();
	});

	it("extracts text from content-block arrays", async () => {
		const { client, addMemory } = makeFakeClient();
		const handler = buildConversationCaptureHandler(client, baseConfig);

		await handler(
			{
				messages: [
					{ role: "user", content: [{ type: "text", text: "block-user" }] },
					{
						role: "assistant",
						content: [
							{ type: "text", text: "block-assistant-1" },
							{ type: "tool_use", id: "t1" },
							{ type: "text", text: "block-assistant-2" },
						],
					},
				],
				success: true,
			},
			{ sessionKey: "main:abc" },
		);

		expect(addMemory).toHaveBeenCalledTimes(1);
		const text = addMemory.mock.calls[0][0] as string;
		expect(text).toContain("User: block-user");
		expect(text).toContain("Assistant: block-assistant-1");
		expect(text).toContain("block-assistant-2");
		expect(text).not.toContain("tool_use");
	});

	it("uses a deterministic resourceId so retries dedupe", async () => {
		const { client, addMemory } = makeFakeClient();
		const handler = buildConversationCaptureHandler(client, baseConfig);

		const event = {
			messages: [
				{ role: "user", content: "a" },
				{ role: "assistant", content: "b" },
			],
			success: true,
		};

		await handler(event, { sessionKey: "main:sess42" });
		await handler(event, { sessionKey: "main:sess42" });

		expect(addMemory).toHaveBeenCalledTimes(2);
		const id1 = (addMemory.mock.calls[0][1] as Record<string, unknown>)
			.resourceId;
		const id2 = (addMemory.mock.calls[1][1] as Record<string, unknown>)
			.resourceId;
		expect(id1).toBe(id2);
		expect(id1).toContain("sess42");
	});

	it("does not throw when the client rejects (fire-and-forget)", async () => {
		const { client, addMemory } = makeFakeClient();
		addMemory.mockRejectedValueOnce(new Error("upstream boom"));
		const handler = buildConversationCaptureHandler(client, baseConfig);

		await expect(
			handler(
				{
					messages: [
						{ role: "user", content: "a" },
						{ role: "assistant", content: "b" },
					],
					success: true,
				},
				{ sessionKey: "main:abc" },
			),
		).resolves.not.toThrow();
	});

	it("truncates combined transcript to 10000 characters", async () => {
		const { client, addMemory } = makeFakeClient();
		const handler = buildConversationCaptureHandler(client, baseConfig);
		const big = "x".repeat(20_000);

		await handler(
			{
				messages: [
					{ role: "user", content: big },
					{ role: "assistant", content: big },
				],
				success: true,
			},
			{ sessionKey: "main:abc" },
		);

		const text = addMemory.mock.calls[0][0] as string;
		expect(text.length).toBeLessThanOrEqual(10_000);
	});
});
