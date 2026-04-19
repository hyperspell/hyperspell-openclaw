import { describe, expect, it, vi } from "vitest";
import { HyperspellClient } from "./client.ts";
import type { HyperspellConfig } from "./config.ts";

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

function makeClient() {
	const client = new HyperspellClient(baseConfig);
	const add = vi.fn().mockResolvedValue({ resource_id: "r1" });
	(client as unknown as { client: { memories: { add: typeof add } } }).client =
		{
			memories: { add },
		} as never;
	return { client, add };
}

describe("HyperspellClient.addMemory", () => {
	it("defaults openclaw_source to 'command' when caller omits it", async () => {
		const { client, add } = makeClient();
		await client.addMemory("hi");
		const metadata = (
			add.mock.calls[0][0] as { metadata: Record<string, unknown> }
		).metadata;
		expect(metadata.openclaw_source).toBe("command");
	});

	it("lets the caller override openclaw_source in metadata", async () => {
		const { client, add } = makeClient();
		await client.addMemory("hi", {
			metadata: { openclaw_source: "conversation" },
		});
		const metadata = (
			add.mock.calls[0][0] as { metadata: Record<string, unknown> }
		).metadata;
		expect(metadata.openclaw_source).toBe("conversation");
	});
});
