import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { HyperspellClient } from "../client.ts";
import type { HyperspellConfig, HyperspellSource } from "../config.ts";
import { getWorkspaceDir } from "../config.ts";
import { log } from "../logger.ts";
import { deleteLocalMemoryFile, syncAllMemoryFiles } from "../sync/markdown.ts";

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}…`;
}

function formatScore(score: number | null): string {
	if (score === null) return "";
	return ` (${Math.round(score * 100)}%)`;
}

export function registerCommands(
	api: OpenClawPluginApi,
	client: HyperspellClient,
	_cfg: HyperspellConfig,
): void {
	// /getcontext <query> - Search memories and show summaries
	api.registerCommand({
		name: "getcontext",
		description: "Search your memories for relevant context",
		acceptsArgs: true,
		requireAuth: true,
		handler: async (ctx: { args?: string }) => {
			const query = ctx.args?.trim();
			if (!query) {
				return { text: "Usage: /getcontext <search query>" };
			}

			log.debug(`/getcontext command: "${query}"`);

			try {
				const results = await client.search(query, { limit: 5 });

				if (results.length === 0) {
					return { text: `No memories found for: "${query}"` };
				}

				const lines = results.map((r, i) => {
					const title = r.title ? truncate(r.title, 60) : `[${r.source}]`;
					const score = formatScore(r.score);
					return `${i + 1}. ${title}${score}`;
				});

				return {
					text: `Found ${results.length} memories:\n\n${lines.join("\n")}`,
				};
			} catch (err) {
				log.error("/getcontext failed", err);
				return { text: "Failed to search memories. Check logs for details." };
			}
		},
	});

	// /remember <text> - Add a new memory
	api.registerCommand({
		name: "remember",
		description: "Save something to memory",
		acceptsArgs: true,
		requireAuth: true,
		handler: async (ctx: { args?: string }) => {
			const text = ctx.args?.trim();
			if (!text) {
				return { text: "Usage: /remember <text to remember>" };
			}

			log.debug(`/remember command: "${truncate(text, 50)}"`);

			try {
				await client.addMemory(text, {
					metadata: { source: "openclaw_command" },
				});

				const preview = truncate(text, 60);
				return { text: `Remembered: "${preview}"` };
			} catch (err) {
				log.error("/remember failed", err);
				return { text: "Failed to save memory. Check logs for details." };
			}
		},
	});

	// /forget <query> - Search and delete matching memories
	api.registerCommand({
		name: "forget",
		description: "Find and delete memories matching a query",
		acceptsArgs: true,
		requireAuth: true,
		handler: async (ctx: { args?: string }) => {
			const query = ctx.args?.trim();
			if (!query) {
				return { text: "Usage: /forget <search query>" };
			}

			log.debug(`/forget command: "${query}"`);

			try {
				const response = await client.searchRaw(query, { limit: 5 });
				const documents = (response.documents ?? []) as Array<{
					source: string;
					resource_id: string;
					score?: number;
					title?: string;
				}>;

				if (documents.length === 0) {
					return { text: `No memories found matching: "${query}"` };
				}

				const workspaceDir = getWorkspaceDir();
				const results: string[] = [];
				let deleted = 0;

				for (const doc of documents) {
					try {
						await client.deleteMemory(
							doc.resource_id,
							doc.source as HyperspellSource,
						);

						const localDeleted = deleteLocalMemoryFile(
							workspaceDir,
							doc.resource_id,
						);
						const localNote = localDeleted ? " + local file" : "";
						const title = doc.title
							? truncate(doc.title, 50)
							: `[${doc.source}]`;
						results.push(`  Deleted: ${title}${localNote}`);
						deleted++;
					} catch (err) {
						const title = doc.title
							? truncate(doc.title, 50)
							: `[${doc.source}]`;
						const msg = err instanceof Error ? err.message : String(err);
						results.push(`  Failed: ${title} - ${msg}`);
					}
				}

				return {
					text: `Forgot ${deleted}/${documents.length} memories:\n${results.join("\n")}`,
				};
			} catch (err) {
				log.error("/forget failed", err);
				return { text: "Failed to delete memories. Check logs for details." };
			}
		},
	});

	// /sync - Manually sync memory files
	api.registerCommand({
		name: "sync",
		description: "Sync memory/*.md files with Hyperspell",
		acceptsArgs: false,
		requireAuth: true,
		handler: async () => {
			log.debug("/sync command");

			try {
				const workspaceDir = getWorkspaceDir();
				const result = await syncAllMemoryFiles(client, workspaceDir);

				if (result.synced === 0 && result.failed === 0) {
					return { text: "No memory files found in memory/ directory." };
				}

				if (result.failed > 0) {
					const errors = result.errors.map((e) => `  • ${e}`).join("\n");
					return {
						text: `Synced ${result.synced} files, ${result.failed} failed:\n${errors}`,
					};
				}

				return {
					text: `Synced ${result.synced} memory file(s) to Hyperspell.`,
				};
			} catch (err) {
				log.error("/sync failed", err);
				return { text: "Failed to sync memory files. Check logs for details." };
			}
		},
	});
}
