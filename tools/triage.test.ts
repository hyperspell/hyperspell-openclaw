import assert from "node:assert/strict";
import { test } from "node:test";
import type { HyperspellClient, TriageResult } from "../client.ts";
import { parseConfig } from "../config.ts";
import { createTriageToolFactory } from "./triage.ts";

const cfg = parseConfig({
	apiKey: "k",
	userId: "u1",
	quarantineResources: ["bad-1"],
});

function mkResult(
	over: Partial<TriageResult> & { resourceId: string },
): TriageResult {
	return {
		title: null,
		source: "vault" as TriageResult["source"],
		score: null,
		url: null,
		createdAt: null,
		metaSource: null,
		metaSpeakerRole: null,
		metaFilePath: null,
		metaWriter: null,
		highlights: [],
		quarantined: false,
		...over,
	};
}

function toolWith(results: TriageResult[]) {
	const client = {
		async searchTriage() {
			return results;
		},
	} as unknown as HyperspellClient;
	return createTriageToolFactory(client, cfg)({});
}

async function runText(results: TriageResult[]) {
	const tool = toolWith(results);
	const res = await tool.execute("call-1", { query: "anything" });
	return (res.content[0] as { text: string }).text;
}

test("triage tool — quarantined hits are listed by id but their content is suppressed", async () => {
	const text = await runText([
		mkResult({
			resourceId: "bad-1",
			title: "The scar",
			score: 0.91,
			quarantined: true,
			highlights: [
				{
					id: "h1",
					score: 0.91,
					text: "poison content that must not resurface",
				},
			],
		}),
	]);
	assert.match(text, /bad-1/);
	assert.match(text, /QUARANTINED/);
	assert.match(text, /content suppressed/);
	assert.doesNotMatch(text, /poison content/);
});

test("triage tool — clean hits keep a snippet and the quarantine roster is always shown", async () => {
	const text = await runText([
		mkResult({
			resourceId: "ok-1",
			title: "A note",
			score: 0.8,
			highlights: [{ id: "h1", score: 0.8, text: "an ordinary snippet" }],
		}),
	]);
	assert.match(text, /an ordinary snippet/);
	assert.match(text, /Quarantine list \(1\): bad-1/);
});

test("triage tool — empty result still reports the roster (verifying a quarantine took effect)", async () => {
	const text = await runText([]);
	assert.match(text, /No records found/);
	assert.match(text, /Quarantine list \(1\): bad-1/);
});
