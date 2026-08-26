import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	buildShadowPrompt,
	parseShadowResponse,
	runShadowExtraction,
	SHADOW_LEDGER_NAME,
} from "./local-register.ts";

const CFG = {
	enabled: true,
	model: "test-model",
	url: "http://localhost:11434",
	maxTranscriptChars: 100,
	timeoutMs: 5000,
};

test("shadow prompt — carries all four hard rules and the transcript", () => {
	const p = buildShadowPrompt("user: hello");
	assert.match(p, /nameable moment/);
	assert.match(p, /NO type-level claims/);
	assert.match(p, /PRESERVE the unflattering/);
	assert.match(p, /shop talk/);
	assert.match(p, /user: hello/);
});

test("parseShadowResponse — tolerates fences and preamble; rejects contentless output", () => {
	assert.deepEqual(
		parseShadowResponse('```json\n{"index":"i","content":"c"}\n```'),
		{ index: "i", content: "c" },
	);
	assert.deepEqual(
		parseShadowResponse('Sure! Here you go: {"index":"i","content":"c"} hope that helps'),
		{ index: "i", content: "c" },
	);
	assert.equal(parseShadowResponse('{"index":"i","content":""}'), null);
	assert.equal(parseShadowResponse("not json at all"), null);
});

test("runShadowExtraction — success writes one pair line keyed by the backend id; transcript tail-capped", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-shadow-"));
	let sentBody = "";
	const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
		sentBody = init?.body ?? "";
		return {
			ok: true,
			json: async () => ({ message: { content: '{"index":"the moment","content":"Your relationship..."}' } }),
		};
	}) as unknown as typeof fetch;
	const long = "x".repeat(500) + "TAIL_MARKER";
	const result = await runShadowExtraction(long, "es-backend-1", CFG, {
		stateRoot: dir,
		fetchImpl,
	});
	assert.ok(result);
	assert.equal(result.model, "test-model");
	assert.match(sentBody, /TAIL_MARKER/);
	assert.doesNotMatch(sentBody, /x{200}/, "tail cap applied — old turns not sent");
	const lines = fs
		.readFileSync(path.join(dir, SHADOW_LEDGER_NAME), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	assert.equal(lines.length, 1);
	assert.equal(lines[0].backendResourceId, "es-backend-1");
	assert.equal(lines[0].content, "Your relationship...");
});

test("runShadowExtraction — HTTP error, unparseable output, and thrown fetch all yield null, never throw", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-shadow-"));
	const cases: Array<typeof fetch> = [
		(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch,
		(async () => ({ ok: true, json: async () => ({ message: { content: "garbage" } }) })) as unknown as typeof fetch,
		(async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch,
	];
	for (const fetchImpl of cases) {
		const r = await runShadowExtraction("t", "es-x", CFG, { stateRoot: dir, fetchImpl });
		assert.equal(r, null);
	}
	assert.ok(!fs.existsSync(path.join(dir, SHADOW_LEDGER_NAME)), "no pair line on failure");
});
