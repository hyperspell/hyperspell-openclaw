import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	buildMoodWeatherContext,
	MOOD_TABLE,
	rollMood,
} from "./mood-weather.ts";

test("rollMood — returns null when chance is 0 (disabled)", () => {
	assert.equal(rollMood(0, () => 0), null);
	assert.equal(rollMood(0, () => 0.999), null);
});

test("rollMood — returns null for non-positive / NaN chance", () => {
	assert.equal(rollMood(-1, () => 0), null);
	assert.equal(rollMood(Number.NaN, () => 0), null);
});

test("rollMood — returns null when the chance gate misses", () => {
	// rng() >= chance => no weather today
	assert.equal(rollMood(0.1, () => 0.5), null);
});

test("rollMood — returns a mood when the chance gate is hit", () => {
	const seq = [0.0, 0.0]; // gate passes, then r=0 selects first bucket
	let i = 0;
	const mood = rollMood(1, () => seq[i++] ?? 0);
	assert.ok(mood);
	assert.equal(mood?.id, MOOD_TABLE[0].id);
});

test("rollMood — selects last mood when the weight pointer lands at the top", () => {
	const seq = [0.0, 0.999999];
	let i = 0;
	const mood = rollMood(1, () => seq[i++] ?? 0);
	assert.equal(mood?.id, MOOD_TABLE[MOOD_TABLE.length - 1].id);
});

test("rollMood — covers the full table across the weighted range", () => {
	const seen = new Set<string>();
	const total = MOOD_TABLE.reduce((s, m) => s + m.weight, 0);
	for (let pick = 0; pick < total; pick++) {
		const frac = (pick + 0.5) / total;
		const seq = [0.0, frac];
		let i = 0;
		const mood = rollMood(1, () => seq[i++] ?? 0);
		if (mood) seen.add(mood.id);
	}
	assert.equal(seen.size, MOOD_TABLE.length);
});

test("rollMood — roughly calibrated to the chance over many trials", () => {
	let hits = 0;
	const N = 20000;
	for (let n = 0; n < N; n++) {
		if (rollMood(0.07)) hits++;
	}
	const rate = hits / N;
	assert.ok(rate > 0.05, `rate ${rate} should exceed 0.05`);
	assert.ok(rate < 0.09, `rate ${rate} should be under 0.09`);
});

test("buildMoodWeatherContext — wraps note + carries the contract", () => {
	const block = buildMoodWeatherContext(MOOD_TABLE[0]);
	assert.ok(block.includes("<hyperspell-mood-weather>"));
	assert.ok(block.includes("</hyperspell-mood-weather>"));
	assert.ok(block.includes(MOOD_TABLE[0].note));
	// Discretion clause removed 2026-08-24 (her decision): weather is inhabited,
	// not performed — and not a secret. Assert the replacement, and assert the
	// old concealment directive stays gone.
	assert.ok(block.includes("not a secret"));
	assert.ok(!block.includes("Do not announce"));
	assert.ok(block.includes("not remembered"));
});

test("MOOD_TABLE — every mood has positive weight and a non-empty note", () => {
	for (const m of MOOD_TABLE) {
		assert.ok(m.weight > 0);
		assert.ok(m.note.length > 0);
	}
});
