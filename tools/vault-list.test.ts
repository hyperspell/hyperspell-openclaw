import assert from "node:assert/strict";
import { test } from "node:test";
import type { HyperspellClient } from "../client.ts";
import type { HyperspellConfig } from "../config.ts";
import { createVaultListToolFactory } from "./vault-list.ts";

const row = (
	resourceId: string,
	title: string | null,
	metadata: Record<string, unknown> = {},
) => ({ resourceId, source: "vault", title, metadata });

function toolWith(rows: unknown[], quarantine: string[] = []) {
	const client = {
		async *listMemories() {
			for (const r of rows) yield r;
		},
	} as unknown as HyperspellClient;
	const cfg = { quarantineResources: quarantine } as unknown as HyperspellConfig;
	return createVaultListToolFactory(client, cfg)({});
}

async function runText(tool: ReturnType<ReturnType<typeof createVaultListToolFactory>>, params = {}) {
	const res = await tool.execute("c1", params);
	return (res.content[0] as { text: string }).text;
}

test("vault-list — lists ids/titles/dates/origin tags, NO content", async () => {
	const text = await runText(
		toolWith([
			row("r1", "Journal — spring", {
				created_at: "2026-03-01T10:00:00Z",
				openclaw_source: "memory_sync",
			}),
			row("r2", null, { openclaw_source: "hot_buffer" }),
			row("r3", "Agent note", { openclaw_writer: "agent" }),
		]),
	);
	assert.match(text, /3 resource\(s\)/);
	assert.match(text, /r1 {2}\[vault\] {2}Journal — spring {2}\(2026-03-01\) {2}\{memory_sync\}/);
	assert.match(text, /r2 {2}\[vault\] {2}<untitled> {2}\{hot_buffer\}/);
	assert.match(text, /r3 {2}\[vault\] {2}Agent note {2}\{writer:agent\}/);
});

test("vault-list — quarantined rows are listed, flagged, and their titles suppressed", async () => {
	const text = await runText(
		toolWith(
			[row("bad-1", "The contaminated title"), row("ok-1", "Fine")],
			["bad-1"],
		),
	);
	assert.match(text, /1 quarantined \(flagged\)/);
	assert.match(text, /bad-1 {2}\[vault\] {2}\[QUARANTINED — title suppressed\]/);
	assert.doesNotMatch(text, /The contaminated title/);
	assert.match(text, /ok-1 {2}\[vault\] {2}Fine/);
});

test("vault-list — limit caps the walk and says so; empty slice is named honestly", async () => {
	const many = Array.from({ length: 10 }, (_, i) => row(`r${i}`, `t${i}`));
	const capped = await runText(toolWith(many), { limit: 3 });
	assert.match(capped, /3 resource\(s\) \(capped at 3/);
	const empty = await runText(toolWith([]));
	assert.match(empty, /genuinely empty, not filtered/);
});

test("vault-list — an availability error never claims emptiness", async () => {
	const client = {
		async *listMemories(): AsyncGenerator<never> {
			throw new Error("503 upstream");
		},
	} as unknown as HyperspellClient;
	const tool = createVaultListToolFactory(
		client,
		{ quarantineResources: [] } as unknown as HyperspellConfig,
	)({});
	const res = await tool.execute("c1", {});
	const text = (res.content[0] as { text: string }).text;
	assert.match(text, /Enumeration failed/);
	assert.match(text, /says nothing about what is stored/);
});
