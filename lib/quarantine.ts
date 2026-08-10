/**
 * Read-side retrieval quarantine (`quarantineResources` config).
 *
 * Specific vault resources — correctly attributed, deliberately KEPT records
 * that must nonetheless stop surfacing as live context (the "true-but-poison
 * testimony" class: e.g. an amnesiac session's self-description that is false
 * about who the agent is NOW) — are dropped from every retrieval-pool read.
 * Full rationale and the backend-filter alternatives this replaces:
 * docs/quarantine-retrieval.md.
 *
 * Enforced at the client boundary (client.ts search/searchRaw/searchWithAnswer)
 * so no retrieval path can forget it, plus the two listMemories-fed context
 * paths in startup-orientation. Addressed reads (`getMemory` by id) and
 * management enumeration (`listMemories`, which purge-channel relies on) are
 * deliberately NOT filtered: quarantine stops ambient injection of a kept
 * record, it does not make the record unreadable.
 */

import { log } from "../logger.ts";

/**
 * Cap on how many extra results a search may over-fetch to compensate for
 * quarantined hits eating pool slots. Bounds the wire cost if an operator
 * ever quarantines a large set; a hit list longer than this can shrink
 * result counts, which is acceptable — correctness never depends on it.
 */
const OVERFETCH_CAP = 20;

/**
 * Widen a fetch limit so quarantined hits don't consume result slots.
 * Callers trim back to the requested limit after the drop.
 */
export function overfetchLimit(limit: number, quarantineCount: number): number {
	return limit + Math.min(quarantineCount, OVERFETCH_CAP);
}

/**
 * Drop items whose resource id is quarantined. Purely subtractive and
 * fail-open: an empty list or an item with no resolvable id passes through
 * unchanged — quarantine can only hide the listed records, never lose others.
 * Ids match exactly (vault resource ids are case-sensitive).
 */
export function dropQuarantined<T>(
	items: T[],
	quarantineResources: readonly string[],
	idOf: (item: T) => string | undefined,
	label: string,
): T[] {
	if (quarantineResources.length === 0 || items.length === 0) return items;
	const ids = new Set(quarantineResources);
	const kept = items.filter((item) => {
		const id = idOf(item);
		return !id || !ids.has(id);
	});
	const dropped = items.length - kept.length;
	if (dropped > 0) {
		// diag, not debug: an active quarantine must be observable in gateway
		// logs (it changes what the agent can recall), same bar as injection
		// summaries.
		log.diag(`${label}: quarantine dropped ${dropped} result(s)`);
	}
	return kept;
}
