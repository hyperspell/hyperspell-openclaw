import assert from "node:assert/strict";
import { test } from "node:test";
import { dropQuarantined, overfetchLimit } from "./quarantine.ts";

test("overfetchLimit — widens by the quarantine count", () => {
	assert.equal(overfetchLimit(5, 0), 5);
	assert.equal(overfetchLimit(5, 3), 8);
});

test("overfetchLimit — caps the widening so a huge list can't explode wire cost", () => {
	assert.equal(overfetchLimit(5, 500), 25);
});

test("dropQuarantined — empty list is a passthrough (same reference, no work)", () => {
	const items = [{ id: "a" }, { id: "b" }];
	const out = dropQuarantined(items, [], (i) => i.id, "test");
	assert.equal(out, items);
});

test("dropQuarantined — drops exactly the listed ids", () => {
	const items = [{ id: "keep-1" }, { id: "bad-1" }, { id: "keep-2" }, { id: "bad-2" }];
	const out = dropQuarantined(items, ["bad-1", "bad-2"], (i) => i.id, "test");
	assert.deepEqual(out.map((i) => i.id), ["keep-1", "keep-2"]);
});

test("dropQuarantined — fail-open: items with no resolvable id are kept", () => {
	const items = [{ id: undefined as string | undefined }, { id: "bad-1" }];
	const out = dropQuarantined(items, ["bad-1"], (i) => i.id, "test");
	assert.deepEqual(out, [{ id: undefined }]);
});

test("dropQuarantined — ids match exactly (resource ids are case-sensitive)", () => {
	const items = [{ id: "bmUWAL0A8ieq9Q" }, { id: "bmuwal0a8ieq9q" }];
	const out = dropQuarantined(items, ["bmUWAL0A8ieq9Q"], (i) => i.id, "test");
	assert.deepEqual(out.map((i) => i.id), ["bmuwal0a8ieq9q"]);
});
