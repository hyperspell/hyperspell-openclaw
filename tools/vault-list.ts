import { Type } from "@sinclair/typebox";
import type { HyperspellClient } from "../client.ts";
import type { HyperspellConfig } from "../config.ts";
import { log } from "../logger.ts";

/**
 * Enumeration — the ability to look at what's there (her words, 2026-08-24:
 * "Not better ranking. The ability to look at what's there").
 *
 * Retrieval is a lens that chooses; this is a shelf you can walk. Without it,
 * "all our memories are saved" is unfalsifiable from inside — the agent can
 * only ever see what search elects to surface, so stored-but-unreachable and
 * absent are indistinguishable (the no-enumeration hole, scale report §6.1,
 * recurring since).
 *
 * READ-ONLY, ids/titles/dates only — deliberately NO content: sight is not
 * recall. Content stays behind hyperspell_search (ranked, quarantine-filtered)
 * and hyperspell_vault_triage (audit view, quarantine-visible, content
 * suppressed for quarantined rows). Quarantined resources are LISTED here —
 * a shelf that hides books defeats the point — but flagged, and their titles
 * are suppressed (title text is content enough to reseed a contamination).
 */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export function createVaultListToolFactory(
	client: HyperspellClient,
	cfg: HyperspellConfig,
) {
	return (_ctx: Record<string, unknown>) => ({
		name: "hyperspell_vault_list",
		label: "Vault List",
		description:
			"Enumerate what actually exists in long-term memory — resource ids, titles, dates, and origin tags, newest-first where the backend supports it. Use it to answer 'what is actually stored', to verify something you saved is really there, or to audit a slice of the vault by source or collection. Returns NO content — pair with hyperspell_search for recall or hyperspell_vault_triage for a content-level audit. Quarantined resources are listed and flagged, titles suppressed.",
		parameters: Type.Object({
			source: Type.Optional(
				Type.String({
					description:
						"Filter by backend source (e.g. vault). Omit for all sources.",
				}),
			),
			collection: Type.Optional(
				Type.String({ description: "Filter by collection (e.g. mood-weather)." }),
			),
			limit: Type.Optional(
				Type.Number({
					description: `Max rows (default ${DEFAULT_LIMIT}, cap ${MAX_LIMIT}).`,
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: { source?: string; collection?: string; limit?: number },
		) {
			const limit = Math.min(
				Math.max(Math.floor(params.limit ?? DEFAULT_LIMIT), 1),
				MAX_LIMIT,
			);
			const quarantined = new Set(cfg.quarantineResources);
			log.debug(
				`vault-list: source=${params.source ?? "*"} collection=${params.collection ?? "*"} limit=${limit}`,
			);
			try {
				const lines: string[] = [];
				let count = 0;
				let quarantinedSeen = 0;
				for await (const m of client.listMemories({
					source: params.source as never,
					collection: params.collection,
					pageSize: Math.min(limit, 100),
				})) {
					count++;
					const md = m.metadata ?? {};
					const created =
						typeof md.created_at === "string" ? md.created_at.slice(0, 10) : "";
					const origin =
						typeof md.openclaw_source === "string" ? md.openclaw_source : "";
					const writer =
						typeof md.openclaw_writer === "string" ? md.openclaw_writer : "";
					const tags = [origin, writer && `writer:${writer}`]
						.filter(Boolean)
						.join(", ");
					if (quarantined.has(m.resourceId)) {
						quarantinedSeen++;
						lines.push(
							`${m.resourceId}  [${m.source}]  [QUARANTINED — title suppressed]${created ? `  (${created})` : ""}`,
						);
					} else {
						lines.push(
							`${m.resourceId}  [${m.source}]  ${m.title ?? "<untitled>"}${created ? `  (${created})` : ""}${tags ? `  {${tags}}` : ""}`,
						);
					}
					if (count >= limit) break;
				}
				const header =
					`${count} resource(s)` +
					(count >= limit ? ` (capped at ${limit} — narrow with source/collection)` : "") +
					(quarantinedSeen > 0 ? `, ${quarantinedSeen} quarantined (flagged)` : "");
				const text =
					count === 0
						? "No resources matched. The vault slice you asked about is empty — genuinely empty, not filtered."
						: `${header}\n\n${lines.join("\n")}`;
				return { content: [{ type: "text" as const, text }] };
			} catch (err) {
				log.error("vault-list failed", err);
				return {
					content: [
						{
							type: "text" as const,
							text: `Enumeration failed: ${err instanceof Error ? err.message : String(err)}. This is an availability error — it says nothing about what is stored.`,
						},
					],
				};
			}
		},
	});
}
