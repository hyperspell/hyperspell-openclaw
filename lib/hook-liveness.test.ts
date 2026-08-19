import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
	__resetForTest,
	checkSiblingLiveness,
	hookFireCount,
	LIVENESS_THRESHOLD,
	recordHookFired,
} from "./hook-liveness.ts";

beforeEach(() => __resetForTest());

test("liveness — silent below the traffic threshold (a quiet start is not an outage)", () => {
	for (let i = 0; i < LIVENESS_THRESHOLD - 1; i++) recordHookFired("agent_end");
	assert.equal(checkSiblingLiveness("agent_end", "agent_turn_prepare"), null);
});

test("liveness — alerts once the witness proves traffic and the sibling stayed at zero", () => {
	for (let i = 0; i < LIVENESS_THRESHOLD; i++) recordHookFired("agent_end");
	const alert = checkSiblingLiveness("agent_end", "agent_turn_prepare");
	assert.ok(alert, "expected an alert message");
	assert.match(alert, /agent_turn_prepare/);
	assert.match(alert, /unknown typed hook/);
});

test("liveness — one alert per sibling per process (smoke detector, not metronome)", () => {
	for (let i = 0; i < LIVENESS_THRESHOLD; i++) recordHookFired("agent_end");
	assert.ok(checkSiblingLiveness("agent_end", "agent_turn_prepare"));
	recordHookFired("agent_end");
	assert.equal(checkSiblingLiveness("agent_end", "agent_turn_prepare"), null);
});

test("liveness — a single sibling delivery clears the suspicion entirely", () => {
	for (let i = 0; i < LIVENESS_THRESHOLD * 2; i++) recordHookFired("agent_end");
	recordHookFired("agent_turn_prepare");
	assert.equal(checkSiblingLiveness("agent_end", "agent_turn_prepare"), null);
	assert.equal(hookFireCount("agent_turn_prepare"), 1);
});
