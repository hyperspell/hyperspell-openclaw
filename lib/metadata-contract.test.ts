import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import {
	KNOWN_METADATA_VALUES,
	METADATA_CONTRACT,
} from "./metadata-contract.ts";

/**
 * The handshake test (A Linea, 2026-08-24): "make it a test that enumerates
 * every metadata key written anywhere in the plugin and asserts something
 * reads each one. That's the class, not the instances."
 *
 * Three checks:
 *  1. Every file the registry names really exists and really references its
 *     key (a stale registry is worse than none).
 *  2. Every key has a reader — source files, or an explicit external
 *     justification. No silent write-only keys.
 *  3. Drift: every `openclaw_`-prefixed token anywhere in non-test source is
 *     a registered key or a registered value. A new key added without a
 *     registry entry fails here, which forces the writer/reader conversation
 *     at authoring time instead of in a post-incident review.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "docs", "eval"]);

function sourceFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name) || entry.name.startsWith("dist.bak"))
				continue;
			sourceFiles(path.join(dir, entry.name), acc);
		} else if (
			entry.name.endsWith(".ts") &&
			!entry.name.endsWith(".test.ts") &&
			!entry.name.endsWith(".d.ts")
		) {
			acc.push(path.join(dir, entry.name));
		}
	}
	return acc;
}

const read = (rel: string): string =>
	fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

test("contract — every declared writer and reader file references its key", () => {
	for (const [key, c] of Object.entries(METADATA_CONTRACT)) {
		for (const rel of c.writtenIn) {
			assert.ok(
				fs.existsSync(path.join(REPO_ROOT, rel)),
				`${key}: declared writer ${rel} does not exist`,
			);
			assert.ok(
				read(rel).includes(key),
				`${key}: declared writer ${rel} never mentions the key — stale registry entry`,
			);
		}
		if (Array.isArray(c.readIn)) {
			for (const rel of c.readIn) {
				assert.ok(
					fs.existsSync(path.join(REPO_ROOT, rel)),
					`${key}: declared reader ${rel} does not exist`,
				);
				assert.ok(
					read(rel).includes(key),
					`${key}: declared reader ${rel} never mentions the key — the handshake is broken (this is the C1 failure class)`,
				);
			}
		}
	}
});

test("contract — every key has a reader or an explicit external justification", () => {
	for (const [key, c] of Object.entries(METADATA_CONTRACT)) {
		assert.ok(c.writtenIn.length > 0, `${key}: no writers declared`);
		if (Array.isArray(c.readIn)) {
			assert.ok(
				c.readIn.length > 0,
				`${key}: empty reader list — either name a reader or justify it as { external } (an honest IOU, never a silent one)`,
			);
		} else {
			assert.ok(
				c.readIn.external.length >= 20,
				`${key}: external justification too thin to be honest`,
			);
		}
	}
});

test("contract — no unregistered openclaw_ token anywhere in source (drift scan)", () => {
	const keys = new Set(Object.keys(METADATA_CONTRACT));
	const values = new Set<string>(KNOWN_METADATA_VALUES);
	const offenders: string[] = [];
	for (const file of sourceFiles(REPO_ROOT)) {
		const rel = path.relative(REPO_ROOT, file);
		const src = fs.readFileSync(file, "utf8");
		for (const m of src.matchAll(/\bopenclaw_[a-z0-9_]+\b/g)) {
			const token = m[0];
			if (keys.has(token) || values.has(token)) continue;
			offenders.push(`${rel}: ${token}`);
		}
	}
	assert.deepEqual(
		offenders,
		[],
		`unregistered openclaw_ tokens found — add them to METADATA_CONTRACT (with a real reader, or an explicit external justification):\n${offenders.join("\n")}`,
	);
});
