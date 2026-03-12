import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { HyperspellClient } from "../client.ts";
import type { HyperspellConfig, HyperspellSource } from "../config.ts";
import { getWorkspaceDir } from "../config.ts";
import { log } from "../logger.ts";
import { deleteLocalMemoryFile } from "../sync/markdown.ts";

export function registerForgetTool(
	api: OpenClawPluginApi,
	client: HyperspellClient,
	_cfg: HyperspellConfig,
): void {
	const workspaceDir = getWorkspaceDir();

	api.registerTool(
		{
			name: "hyperspell_forget",
			label: "Memory Forget",
			description:
				"Delete memories that match a search query. Use when the user says to forget something, correct outdated info, or remove sensitive data. Searches for matching memories first, then deletes them from Hyperspell and cleans up local markdown files.",
			parameters: Type.Object({
				query: Type.String({
					description: "Search query to find memories to delete",
				}),
				limit: Type.Optional(
					Type.Number({
						description: "Max memories to delete (default: 3)",
					}),
				),
				confirm: Type.Optional(
					Type.Boolean({
						description:
							"Set to true to confirm deletion. First call without confirm to preview matches, then call again with confirm: true to delete.",
					}),
				),
			}),
			async execute(
				_toolCallId: string,
				params: { query: string; limit?: number; confirm?: boolean },
			) {
				const limit = params.limit ?? 3;
				log.debug(
					`forget tool: query="${params.query}" limit=${limit} confirm=${params.confirm}`,
				);

				try {
					const response = await client.searchRaw(params.query, { limit });
					const documents = (response.documents ?? []) as Array<{
						source: string;
						resource_id: string;
						score?: number;
						title?: string;
						summary?: string;
					}>;

					if (documents.length === 0) {
						return {
							content: [
								{
									type: "text" as const,
									text: `No memories found matching: "${params.query}"`,
								},
							],
						};
					}

					// Preview mode: show matches without deleting
					if (!params.confirm) {
						const preview = documents
							.map((doc, i) => {
								const title = doc.title || "(untitled)";
								const score = doc.score
									? ` (${Math.round(doc.score * 100)}% match)`
									: "";
								return `${i + 1}. [${doc.source}] ${title}${score} (id: ${doc.resource_id})`;
							})
							.join("\n");

						return {
							content: [
								{
									type: "text" as const,
									text: `Found ${documents.length} memories to delete:\n\n${preview}\n\nCall again with confirm: true to delete these memories.`,
								},
							],
							details: { count: documents.length, documents },
						};
					}

					// Delete mode: remove each matching memory
					const results: string[] = [];
					let deleted = 0;
					let failed = 0;

					for (const doc of documents) {
						try {
							await client.deleteMemory(
								doc.resource_id,
								doc.source as HyperspellSource,
							);

							// Clean up local markdown file if it exists
							const localDeleted = deleteLocalMemoryFile(
								workspaceDir,
								doc.resource_id,
							);
							const localNote = localDeleted ? " (local file removed)" : "";

							results.push(
								`Deleted: [${doc.source}] ${doc.title || "(untitled)"}${localNote}`,
							);
							deleted++;
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							results.push(
								`Failed: [${doc.source}] ${doc.title || "(untitled)"} - ${msg}`,
							);
							failed++;
						}
					}

					const summary =
						failed > 0
							? `Deleted ${deleted} memories, ${failed} failed:\n\n${results.join("\n")}`
							: `Deleted ${deleted} memories:\n\n${results.join("\n")}`;

					return {
						content: [{ type: "text" as const, text: summary }],
					};
				} catch (err) {
					log.error("forget tool failed", err);
					return {
						content: [
							{
								type: "text" as const,
								text: `Failed to forget memories: ${err instanceof Error ? err.message : String(err)}`,
							},
						],
					};
				}
			},
		},
		{ name: "hyperspell_forget" },
	);
}
