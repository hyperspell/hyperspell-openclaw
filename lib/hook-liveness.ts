/**
 * Cross-hook liveness watchdog (scale report §1.4, the 2026-07-24 outage).
 *
 * When a gateway update drops a typed hook name, the host logs a warn and
 * keeps loading — the plugin's handler simply never fires again. Last time
 * that meant writes kept working while ALL context injection was silently
 * dead for ~21 hours; nothing plugin-side noticed because dead hooks produce
 * no events to notice from.
 *
 * The detector is the outage's own diagnostic asymmetry, automated: hooks
 * that ARE firing prove there is live traffic, so a sibling hook stuck at
 * zero over that same traffic is dead, not idle. This can only catch PARTIAL
 * hook loss (some hook must survive to witness the traffic) — total loss has
 * no in-process signal and stays an operator concern.
 */

const fired = new Map<string, number>();
const alerted = new Set<string>();

/** How many witness-hook firings with a sibling at zero count as proof of
 * death rather than a quiet start. Turn-scale hooks fire once per turn, so
 * this trips within a handful of messages after a breaking gateway update. */
export const LIVENESS_THRESHOLD = 5;

/** Record a hook delivery. Call at handler ENTRY, before any guard (a
 * quarantined or skipped turn still proves the gateway delivered the hook). */
export function recordHookFired(hook: string): void {
	fired.set(hook, (fired.get(hook) ?? 0) + 1);
}

export function hookFireCount(hook: string): number {
	return fired.get(hook) ?? 0;
}

/**
 * From a firing witness hook, check whether an expected sibling hook is dead.
 * Returns the alert message the first time the asymmetry is proven (caller
 * logs it at error level); null otherwise. One alert per sibling per process —
 * this is a smoke detector, not a metronome.
 */
export function checkSiblingLiveness(
	witness: string,
	sibling: string,
): string | null {
	if (alerted.has(sibling)) return null;
	if (hookFireCount(sibling) > 0) return null;
	if (hookFireCount(witness) < LIVENESS_THRESHOLD) return null;
	alerted.add(sibling);
	return (
		`hook "${sibling}" has not fired once while "${witness}" fired ${hookFireCount(witness)} times — ` +
		`the gateway has almost certainly dropped it (typed-hook rename/removal on a host update; ` +
		`compare the 2026-07-24 before_agent_start outage). The feature behind it is silently OFF. ` +
		`Check gateway logs for 'unknown typed hook' and update the plugin's hook registration.`
	);
}

/** Test-only: reset module state between cases. */
export function __resetForTest(): void {
	fired.clear();
	alerted.clear();
}
