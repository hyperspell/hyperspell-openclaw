import { Type } from "@sinclair/typebox";
import type { HyperspellClient } from "../client.ts";
import type { HyperspellConfig } from "../config.ts";
import {
	classifySearchError,
	logSearchError,
	searchErrorToolText,
} from "../lib/search-error.ts";
import { resolveUser } from "../lib/sender.ts";
import { log } from "../logger.ts";

/**
 * Read-only vault audit view (roadmap Phase 3; scale report §6.1).
 *
 * Quarantine is reactive by construction: with no enumeration API, a bad
 * record is normally discovered only by being injected — every quarantine
 * action arrives one contamination too late. This tool closes the gap as far
 * as the plugin can: it is the one retrieval path that searches WITHOUT the
 * quarantine filter, so already-quarantined records are visible (flagged) and
 * candidate bad records can be hunted proactively instead of awaited.
 *
 * Two hard properties, do not weaken:
 *  - READ-ONLY. Nomination happens here; the quarantine WRITE stays a config
 *    change confirmed by the operator (the two-key flow).
 *  - Quarantined hits return id/title/score ONLY — their content is
 *    suppressed. Echoing it would write it into this very conversation's
 *    memory and feed the derivative treadmill the quarantine exists to stop.
 */
export function createTriageToolFactory(
	client: HyperspellClient,
	cfg: HyperspellConfig,
) {
	return (ctx: Record<string, unknown>) => ({
		name: "hyperspell_vault_triage",
		label: "Vault Triage",
		description:
			"Audit view over long-term memory for finding bad, stale, or misattributed records — the only search that also shows quarantined resources (flagged, content suppressed). Use it to answer 'what records exist about X, including ones retrieval hides', to verify a quarantine took effect, or to nominate a record for quarantine by id. Not for normal recall — use hyperspell_search for that. Read-only: quarantining itself is an operator-confirmed config change.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			limit: Type.Optional(
				Type.Number({ description: "Max results (default: 10)" }),
			),
			after: Type.Optional(
				Type.String({
					description:
						"Only records created on or after this date (ISO 8601 or YYYY-MM-DD)",
				}),
			),
			before: Type.Optional(
				Type.String({
					description:
						"Only records created before this date (ISO 8601 or YYYY-MM-DD)",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: {
				query: string;
				limit?: number;
				after?: string;
				before?: string;
			},
		) {
			const limit = params.limit ?? 10;
			const resolved = resolveUser(ctx, cfg);

			log.debug(
				`triage tool: query="${params.query}" limit=${limit} after=${params.after ?? "none"} before=${params.before ?? "none"}`,
			);

			try {
				const results = await client.searchTriage(params.query, {
					limit,
					after: params.after,
					before: params.before,
					userId: resolved?.userId,
				});

				const roster = cfg.quarantineResources;
				const rosterLine =
					roster.length > 0
						? `\n\nQuarantine list (${roster.length}): ${roster.join(", ")}`
						: "\n\nQuarantine list is empty.";

				if (results.length === 0) {
					return {
						content: [
							{ type: "text" as const, text: `No records found.${rosterLine}` },
						],
					};
				}

				const lines = results.map((r, i) => {
					const relevance =
						r.score != null ? `${Math.round(r.score * 100)}%` : "N/A";
					const head = `${i + 1}. [${r.resourceId}] ${r.title ?? "(untitled)"} — ${r.source}${r.metaSource ? `/${r.metaSource}` : ""}, ${relevance}${r.createdAt ? `, ${r.createdAt}` : ""}`;
					if (r.quarantined) {
						return `${head}\n   ⛔ QUARANTINED — content suppressed. Treat this record as retracted; do not restate it.`;
					}
					const snippet = r.highlights[0]?.text?.slice(0, 300);
					return snippet ? `${head}\n   ${snippet}` : head;
				});

				return {
					content: [
						{
							type: "text" as const,
							text: `Triage view — ${results.length} record(s), quarantine NOT filtered:\n\n${lines.join("\n\n")}${rosterLine}`,
						},
					],
					details: {
						count: results.length,
						quarantined: results.filter((r) => r.quarantined).length,
					},
				};
			} catch (err) {
				const info = classifySearchError(err);
				logSearchError(log, "triage tool", info, err);
				return {
					content: [{ type: "text" as const, text: searchErrorToolText(info) }],
				};
			}
		},
	});
}
