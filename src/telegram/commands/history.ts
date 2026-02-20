import { Command } from "commander";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { parseDate } from "@app/utils/date";
import { formatNumber } from "@app/utils/format";
import { formatTable } from "@app/utils/table";
import { embedText, detectLanguage } from "@app/utils/macos/nlp";
import { TelegramToolConfig } from "../lib/TelegramToolConfig";
import { TGClient } from "../lib/TGClient";
import { TelegramHistoryStore } from "../lib/TelegramHistoryStore";
import type { ContactConfig, SearchResult } from "../lib/types";
import { EMBEDDING_LANGUAGES } from "../lib/types";
import { downloadContact, embedMessages } from "../lib/download";
import { displayResults } from "../lib/search";
import { formatMessages, VALID_EXPORT_FORMATS, type ExportFormat } from "../lib/export";

// ── Helpers ───────────────────────────────────────────────────────────

async function ensureClient(config: TelegramToolConfig): Promise<TGClient | null> {
	if (!config.hasValidSession()) {
		p.log.error("Not configured. Run: tools telegram configure");
		return null;
	}

	const client = TGClient.fromConfig(config);
	const authorized = await client.connect();

	if (!authorized) {
		p.log.error("Session expired. Run: tools telegram configure");
		return null;
	}

	return client;
}

function resolveContact(
	contacts: ContactConfig[],
	nameOrId: string,
): ContactConfig | undefined {
	const lower = nameOrId.toLowerCase();

	return contacts.find(
		(c) =>
			c.userId === nameOrId ||
			c.displayName.toLowerCase() === lower ||
			c.username?.toLowerCase() === lower ||
			c.username?.toLowerCase() === lower.replace(/^@/, ""),
	);
}

// ── Download Command ──────────────────────────────────────────────────

function registerDownloadCommand(history: Command): void {
	history
		.command("download [contact]")
		.description("Download conversation history to local SQLite database")
		.option("--since <date>", "Start date (YYYY-MM-DD)")
		.option("--until <date>", "End date (YYYY-MM-DD)")
		.option("--limit <n>", "Max messages to download", parseInt)
		.option("--all", "Download all configured contacts")
		.action(async (contactName: string | undefined, opts: {
			since?: string;
			until?: string;
			limit?: number;
			all?: boolean;
		}) => {
			p.intro(pc.bgMagenta(pc.white(" telegram history download ")));

			const config = new TelegramToolConfig();
			const data = await config.load();

			if (!data) {
				p.log.error("Not configured. Run: tools telegram configure");
				return;
			}

			const contacts = data.contacts;

			if (contacts.length === 0) {
				p.log.warn("No contacts configured. Run: tools telegram configure");
				return;
			}

			let targetContacts: ContactConfig[];

			if (opts.all) {
				targetContacts = contacts;
			} else if (contactName) {
				const found = resolveContact(contacts, contactName);

				if (!found) {
					p.log.error(
						`Contact "${contactName}" not found. Available: ${contacts.map((c) => c.displayName).join(", ")}`,
					);
					return;
				}

				targetContacts = [found];
			} else {
				const selected = await p.select({
					message: "Which contact to download?",
					options: [
						...contacts.map((c) => ({
							value: c.userId,
							label: c.displayName,
							hint: c.username ? `@${c.username}` : undefined,
						})),
						{ value: "__all__", label: "All contacts" },
					],
				});

				if (p.isCancel(selected)) {
					return;
				}

				if (selected === "__all__") {
					targetContacts = contacts;
				} else {
					const found = contacts.find((c) => c.userId === selected);

					if (!found) {
						return;
					}

					targetContacts = [found];
				}
			}

			const spinner = p.spinner();
			spinner.start("Connecting to Telegram...");

			const client = await ensureClient(config);

			if (!client) {
				spinner.stop("Connection failed");
				return;
			}

			spinner.stop("Connected");

			const store = new TelegramHistoryStore();
			store.open();

			const since = opts.since ? parseDate(opts.since) : undefined;
			const until = opts.until ? parseDate(opts.until) : undefined;

			try {
				for (const contact of targetContacts) {
					await downloadContact(client, store, contact, {
						since,
						until,
						limit: opts.limit,
					});
				}

				const shouldEmbed = await p.confirm({
					message: "Generate semantic embeddings for new messages?",
					initialValue: true,
				});

				if (!p.isCancel(shouldEmbed) && shouldEmbed) {
					for (const contact of targetContacts) {
						const embedSpinner = p.spinner();
						embedSpinner.start(`Embedding ${contact.displayName}...`);

						const { embedded, skipped, unsupportedLangs } = await embedMessages(
							store,
							contact.userId,
						);

						embedSpinner.stop(
							`${pc.green(String(embedded))} embeddings generated, ${skipped} skipped`,
						);

						if (unsupportedLangs.size > 0) {
							const langs = [...unsupportedLangs].join(", ");
							p.log.warn(
								`Some messages were in unsupported languages (${langs}). ` +
								`Semantic search only works for: ${[...EMBEDDING_LANGUAGES].join(", ")}. ` +
								`Keyword search still works for all languages.`,
							);
						}
					}
				}
			} finally {
				store.close();
				await client.disconnect();
			}

			p.outro("Download complete.");
		});
}

// ── Embed Command ─────────────────────────────────────────────────────

function registerEmbedCommand(history: Command): void {
	history
		.command("embed [contact]")
		.description("Generate semantic embeddings for downloaded messages")
		.option("--all", "Embed all contacts")
		.action(async (contactName: string | undefined, opts: { all?: boolean }) => {
			p.intro(pc.bgMagenta(pc.white(" telegram history embed ")));

			const config = new TelegramToolConfig();
			const data = await config.load();

			if (!data) {
				p.log.error("Not configured. Run: tools telegram configure");
				return;
			}

			const contacts = data.contacts;

			if (contacts.length === 0) {
				p.log.warn("No contacts configured.");
				return;
			}

			let targetContacts: ContactConfig[];

			if (opts.all) {
				targetContacts = contacts;
			} else if (contactName) {
				const found = resolveContact(contacts, contactName);

				if (!found) {
					p.log.error(
						`Contact "${contactName}" not found. Available: ${contacts.map((c) => c.displayName).join(", ")}`,
					);
					return;
				}

				targetContacts = [found];
			} else {
				const selected = await p.select({
					message: "Which contact to embed?",
					options: [
						...contacts.map((c) => ({
							value: c.userId,
							label: c.displayName,
						})),
						{ value: "__all__", label: "All contacts" },
					],
				});

				if (p.isCancel(selected)) {
					return;
				}

				if (selected === "__all__") {
					targetContacts = contacts;
				} else {
					const found = contacts.find((c) => c.userId === selected);

					if (!found) {
						return;
					}

					targetContacts = [found];
				}
			}

			const store = new TelegramHistoryStore();
			store.open();

			try {
				for (const contact of targetContacts) {
					p.log.step(pc.bold(contact.displayName));

					const spinner = p.spinner();
					spinner.start("Generating embeddings...");

					const { embedded, skipped, unsupportedLangs } = await embedMessages(
						store,
						contact.userId,
					);

					const total = store.getEmbeddedCount(contact.userId);

					spinner.stop(
						`${pc.green(String(embedded))} new embeddings, ${skipped} skipped (${formatNumber(total)} total embedded)`,
					);

					if (unsupportedLangs.size > 0) {
						const langs = [...unsupportedLangs].join(", ");
						p.log.warn(
							`Some messages were in unsupported languages (${langs}). ` +
							`Semantic search only works for: ${[...EMBEDDING_LANGUAGES].join(", ")}. ` +
							`Keyword search still works for all languages.`,
						);
					}
				}
			} finally {
				store.close();
			}

			p.outro("Embedding complete.");
		});
}

// ── Search Command ────────────────────────────────────────────────────

function registerSearchCommand(history: Command): void {
	history
		.command("search <contact> <query>")
		.description("Search conversation history (keyword, semantic, or hybrid)")
		.option("--since <date>", "Start date (YYYY-MM-DD)")
		.option("--until <date>", "End date (YYYY-MM-DD)")
		.option("--semantic", "Use semantic (vector) search instead of keyword")
		.option("--hybrid", "Use hybrid search (keyword + semantic combined)")
		.option("--limit <n>", "Max results (default: 20)", parseInt)
		.action(async (
			contactName: string,
			query: string,
			opts: {
				since?: string;
				until?: string;
				semantic?: boolean;
				hybrid?: boolean;
				limit?: number;
			},
		) => {
			p.intro(pc.bgMagenta(pc.white(" telegram history search ")));

			const config = new TelegramToolConfig();
			const data = await config.load();

			if (!data) {
				p.log.error("Not configured. Run: tools telegram configure");
				return;
			}

			const contact = resolveContact(data.contacts, contactName);

			if (!contact) {
				p.log.error(
					`Contact "${contactName}" not found. Available: ${data.contacts.map((c) => c.displayName).join(", ")}`,
				);
				return;
			}

			const store = new TelegramHistoryStore();
			store.open();

			const searchOpts = {
				since: opts.since ? parseDate(opts.since) : undefined,
				until: opts.until ? parseDate(opts.until) : undefined,
				limit: opts.limit ?? 20,
			};

			let results: SearchResult[];

			try {
				if (opts.semantic || opts.hybrid) {
					const spinner = p.spinner();
					spinner.start("Generating query embedding...");

					let queryEmbedding: Float32Array;

					try {
						const langResult = await detectLanguage(query);
						const lang = EMBEDDING_LANGUAGES.has(langResult.language)
							? langResult.language
							: "en";

						if (!EMBEDDING_LANGUAGES.has(langResult.language)) {
							p.log.warn(
								`Query language "${langResult.language}" is not supported for semantic search. ` +
								`Supported: ${[...EMBEDDING_LANGUAGES].join(", ")}. ` +
								`Results may be less accurate. Use keyword search for best results with this language.`,
							);
						}

						const embedResult = await embedText(query, lang, "sentence");
						queryEmbedding = new Float32Array(embedResult.vector);
						spinner.stop("Query embedded");
					} catch (err) {
						spinner.stop("Embedding failed — falling back to keyword search");
						p.log.warn(`Could not embed query: ${err}`);
						results = store.search(contact.userId, query, searchOpts);

						displayResults(results, contact.displayName);
						store.close();
						return;
					}

					if (opts.hybrid) {
						results = store.hybridSearch(
							contact.userId,
							query,
							queryEmbedding,
							searchOpts,
						);
					} else {
						results = store.semanticSearch(
							contact.userId,
							queryEmbedding,
							searchOpts,
						);
					}
				} else {
					results = store.search(contact.userId, query, searchOpts);
				}

				displayResults(results, contact.displayName);
			} finally {
				store.close();
			}

			p.outro(`${results?.length ?? 0} result(s) found.`);
		});
}

// ── Export Command ────────────────────────────────────────────────────

function registerExportCommand(history: Command): void {
	history
		.command("export <contact>")
		.description("Export conversation to file (JSON, CSV, or plain text)")
		.requiredOption("--format <fmt>", "Output format: json, csv, or txt")
		.option("--since <date>", "Start date (YYYY-MM-DD)")
		.option("--until <date>", "End date (YYYY-MM-DD)")
		.option("-o, --output <path>", "Output file path (default: stdout)")
		.action(async (
			contactName: string,
			opts: {
				format: string;
				since?: string;
				until?: string;
				output?: string;
			},
		) => {
			if (!VALID_EXPORT_FORMATS.includes(opts.format as ExportFormat)) {
				p.log.error(`Invalid format "${opts.format}". Use: ${VALID_EXPORT_FORMATS.join(", ")}`);
				return;
			}

			const config = new TelegramToolConfig();
			const data = await config.load();

			if (!data) {
				p.log.error("Not configured. Run: tools telegram configure");
				return;
			}

			const contact = resolveContact(data.contacts, contactName);

			if (!contact) {
				p.log.error(
					`Contact "${contactName}" not found. Available: ${data.contacts.map((c) => c.displayName).join(", ")}`,
				);
				return;
			}

			const store = new TelegramHistoryStore();
			store.open();

			const since = opts.since ? parseDate(opts.since) : undefined;
			const until = opts.until ? parseDate(opts.until) : undefined;

			const messages = store.getByDateRange(contact.userId, since, until);
			store.close();

			if (messages.length === 0) {
				p.log.warn("No messages found in the specified range.");
				return;
			}

			const output = formatMessages(messages, opts.format as ExportFormat, contact.displayName);

			if (opts.output) {
				const outputPath = resolve(opts.output);
				await Bun.write(outputPath, output);
				p.log.success(`Exported ${formatNumber(messages.length)} messages to ${outputPath}`);
			} else {
				console.log(output);
			}
		});
}

// ── Stats Command ─────────────────────────────────────────────────────

function registerStatsCommand(history: Command): void {
	history
		.command("stats [contact]")
		.description("Show statistics about downloaded conversations")
		.action(async (contactName: string | undefined) => {
			p.intro(pc.bgMagenta(pc.white(" telegram history stats ")));

			const config = new TelegramToolConfig();
			const data = await config.load();

			if (!data) {
				p.log.error("Not configured. Run: tools telegram configure");
				return;
			}

			const store = new TelegramHistoryStore();
			store.open();

			try {
				if (contactName) {
					const contact = resolveContact(data.contacts, contactName);

					if (!contact) {
						p.log.error(
							`Contact "${contactName}" not found. Available: ${data.contacts.map((c) => c.displayName).join(", ")}`,
						);
						return;
					}

					const stats = store.getStats(contact.userId);

					if (stats.length === 0) {
						p.log.warn(`No messages downloaded for ${contact.displayName}. Run: tools telegram history download`);
						return;
					}

					const s = stats[0];
					p.log.info(
						`${pc.bold(contact.displayName)}\n` +
						`  Total messages:    ${formatNumber(s.totalMessages)}\n` +
						`  Sent:              ${formatNumber(s.outgoingMessages)}\n` +
						`  Received:          ${formatNumber(s.incomingMessages)}\n` +
						`  Embedded:          ${formatNumber(s.embeddedMessages)}\n` +
						`  First message:     ${s.firstMessageDate ?? "—"}\n` +
						`  Last message:      ${s.lastMessageDate ?? "—"}`,
					);
				} else {
					const allStats = store.getStats();

					if (allStats.length === 0) {
						p.log.warn("No messages downloaded yet. Run: tools telegram history download");
						return;
					}

					const contactMap = new Map<string, string>();

					for (const c of data.contacts) {
						contactMap.set(c.userId, c.displayName);
					}

					const rows = allStats.map((s) => [
						contactMap.get(s.chatId) ?? s.chatId,
						formatNumber(s.totalMessages),
						formatNumber(s.incomingMessages),
						formatNumber(s.outgoingMessages),
						formatNumber(s.embeddedMessages),
						s.firstMessageDate?.slice(0, 10) ?? "—",
						s.lastMessageDate?.slice(0, 10) ?? "—",
					]);

					const totalMessages = allStats.reduce((sum, s) => sum + s.totalMessages, 0);
					const totalEmbedded = allStats.reduce((sum, s) => sum + s.embeddedMessages, 0);

					console.log();
					console.log(formatTable(
						rows,
						["Contact", "Total", "In", "Out", "Embedded", "First", "Last"],
						{ alignRight: [1, 2, 3, 4] },
					));
					console.log();

					p.log.info(
						`${pc.bold("Summary")}: ${formatNumber(totalMessages)} messages across ${allStats.length} contact(s), ` +
						`${formatNumber(totalEmbedded)} embedded`,
					);
				}
			} finally {
				store.close();
			}

			p.outro("Done.");
		});
}

// ── Registration ──────────────────────────────────────────────────────

export function registerHistoryCommand(program: Command): void {
	const history = program
		.command("history")
		.description("Download, search, and export conversation history");

	registerDownloadCommand(history);
	registerEmbedCommand(history);
	registerSearchCommand(history);
	registerExportCommand(history);
	registerStatsCommand(history);
}
