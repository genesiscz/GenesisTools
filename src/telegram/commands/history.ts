import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import logger from "@app/logger";
import { TelegramToolConfig } from "../lib/TelegramToolConfig";
import { TGClient } from "../lib/TGClient";
import { TelegramMessage } from "../lib/TelegramMessage";
import type { SerializedMessage } from "../lib/TelegramMessage";
import { TelegramHistoryStore } from "../lib/TelegramHistoryStore";
import type { ContactConfig, SearchResult } from "../lib/types";
import { EMBEDDING_LANGUAGES } from "../lib/types";
import { formatNumber } from "@app/utils/format";
import { formatTable } from "@app/utils/table";
import { embedText, detectLanguage } from "@app/utils/macos/nlp";
import type { EmbedResult } from "@app/utils/macos/types";

// ── Helpers ───────────────────────────────────────────────────────────

function parseDate(value: string): Date {
	const d = new Date(value);

	if (Number.isNaN(d.getTime())) {
		throw new Error(`Invalid date: ${value}`);
	}

	return d;
}

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

						const { embedded, skipped } = await embedMessages(
							store,
							contact.userId,
							contact.displayName,
						);

						embedSpinner.stop(
							`${pc.green(String(embedded))} embeddings generated, ${skipped} skipped`,
						);
					}
				}
			} finally {
				store.close();
				await client.disconnect();
			}

			p.outro("Download complete.");
		});
}

async function downloadContact(
	client: TGClient,
	store: TelegramHistoryStore,
	contact: ContactConfig,
	options: { since?: Date; until?: Date; limit?: number },
): Promise<void> {
	p.log.step(pc.bold(contact.displayName));

	const spinner = p.spinner();
	spinner.start("Counting messages...");

	let totalEstimate: number;

	try {
		totalEstimate = await client.getMessageCount(contact.userId);
	} catch {
		spinner.stop("Could not count messages");
		totalEstimate = 0;
	}

	const lastSyncedId = store.getLastSyncedId(contact.userId);
	const isIncremental = lastSyncedId !== null && !options.since;

	if (isIncremental) {
		spinner.stop(`Found ${formatNumber(totalEstimate)} total messages (incremental sync from #${lastSyncedId})`);
	} else {
		spinner.stop(`Found ${formatNumber(totalEstimate)} total messages`);
	}

	const iterOptions: {
		limit?: number;
		offsetDate?: number;
		minId?: number;
	} = {};

	if (options.limit) {
		iterOptions.limit = options.limit;
	}

	if (options.until) {
		iterOptions.offsetDate = Math.floor(options.until.getTime() / 1000);
	}

	if (isIncremental && lastSyncedId !== null) {
		iterOptions.minId = lastSyncedId;
	}

	const progressSpinner = p.spinner();
	progressSpinner.start("Downloading messages...");

	const batch: SerializedMessage[] = [];
	let downloaded = 0;
	let inserted = 0;
	let highestId = lastSyncedId ?? 0;
	let retryCount = 0;
	const BATCH_SIZE = 100;
	const MAX_RETRIES = 5;

	try {
		for await (const apiMessage of client.getMessages(contact.userId, iterOptions)) {
			const msg = new TelegramMessage(apiMessage);

			if (options.since && msg.date < options.since) {
				continue;
			}

			if (options.until && msg.date > options.until) {
				continue;
			}

			batch.push(msg.toJSON());
			downloaded++;

			if (msg.id > highestId) {
				highestId = msg.id;
			}

			if (batch.length >= BATCH_SIZE) {
				const batchInserted = store.insertMessages(contact.userId, batch);
				inserted += batchInserted;
				batch.length = 0;
				retryCount = 0;

				progressSpinner.message(
					`Downloaded ${formatNumber(downloaded)} messages (${formatNumber(inserted)} new)`,
				);
			}
		}
	} catch (err) {
		const errorStr = String(err);

		if (errorStr.includes("FLOOD_WAIT") || errorStr.includes("FloodWait")) {
			const waitMatch = errorStr.match(/(\d+)/);
			const waitSeconds = waitMatch ? parseInt(waitMatch[1], 10) : 30;
			retryCount++;

			if (retryCount <= MAX_RETRIES) {
				const backoff = waitSeconds * Math.pow(2, retryCount - 1);
				progressSpinner.message(
					`Rate limited — waiting ${backoff}s (retry ${retryCount}/${MAX_RETRIES})`,
				);
				await Bun.sleep(backoff * 1000);
			} else {
				progressSpinner.stop(`Rate limited after ${MAX_RETRIES} retries`);
				p.log.warn("Stopped due to persistent rate limiting. Run again later to resume.");
			}
		} else {
			progressSpinner.stop("Error during download");
			p.log.error(`Download error: ${errorStr}`);
		}
	}

	if (batch.length > 0) {
		const batchInserted = store.insertMessages(contact.userId, batch);
		inserted += batchInserted;
	}

	if (highestId > 0) {
		store.setLastSyncedId(contact.userId, highestId);
	}

	progressSpinner.stop(
		`${pc.green(formatNumber(downloaded))} downloaded, ${pc.green(formatNumber(inserted))} new messages stored`,
	);
}

// ── Embed ─────────────────────────────────────────────────────────────

async function embedMessages(
	store: TelegramHistoryStore,
	chatId: string,
	_displayName: string,
): Promise<{ embedded: number; skipped: number }> {
	let embedded = 0;
	let skipped = 0;
	const BATCH_SIZE = 50;

	while (true) {
		const unembedded = store.getUnembeddedMessages(chatId, BATCH_SIZE);

		if (unembedded.length === 0) {
			break;
		}

		for (const msg of unembedded) {
			if (!msg.text || msg.text.trim().length < 3) {
				skipped++;
				continue;
			}

			try {
				const langResult = await detectLanguage(msg.text);

				if (!EMBEDDING_LANGUAGES.has(langResult.language)) {
					skipped++;
					continue;
				}

				const result: EmbedResult = await embedText(msg.text, langResult.language, "sentence");
				const embedding = new Float32Array(result.vector);
				store.insertEmbedding(chatId, msg.id, embedding);
				embedded++;
			} catch (err) {
				logger.debug(`Embedding failed for message ${msg.id}: ${err}`);
				skipped++;
			}
		}
	}

	return { embedded, skipped };
}

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

					const { embedded, skipped } = await embedMessages(
						store,
						contact.userId,
						contact.displayName,
					);

					const total = store.getEmbeddedCount(contact.userId);

					spinner.stop(
						`${pc.green(String(embedded))} new embeddings, ${skipped} skipped (${formatNumber(total)} total embedded)`,
					);
				}
			} finally {
				store.close();
			}

			p.outro("Embedding complete.");
		});
}

// ── Search Command ────────────────────────────────────────────────────

function formatSearchResult(result: SearchResult, contactName: string): string {
	const msg = result.message;
	const date = new Date(msg.date_unix * 1000);
	const dateStr = date.toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
	const direction = msg.is_outgoing ? pc.blue("You") : pc.cyan(contactName);
	const text = msg.text || msg.media_desc || "(no text)";
	const preview = text.length > 120 ? `${text.slice(0, 120)}...` : text;

	let scoreLabel = "";

	if (result.score !== undefined) {
		scoreLabel = pc.dim(` [score: ${result.score.toFixed(4)}]`);
	} else if (result.distance !== undefined) {
		scoreLabel = pc.dim(` [dist: ${result.distance.toFixed(4)}]`);
	} else if (result.rank !== undefined) {
		scoreLabel = pc.dim(` [rank: ${result.rank.toFixed(2)}]`);
	}

	return `${pc.dim(dateStr)} ${direction}: ${preview}${scoreLabel}`;
}

function displayResults(results: SearchResult[], contactName: string): void {
	if (results.length === 0) {
		p.log.warn("No results found.");
		return;
	}

	for (const result of results) {
		p.log.info(formatSearchResult(result, contactName));
	}
}

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

			p.outro(`${results!.length} result(s) found.`);
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
			const validFormats = ["json", "csv", "txt"];

			if (!validFormats.includes(opts.format)) {
				p.log.error(`Invalid format "${opts.format}". Use: ${validFormats.join(", ")}`);
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

			let output: string;

			switch (opts.format) {
				case "json":
					output = JSON.stringify(messages, null, 2);
					break;

				case "csv": {
					const header = "id,date,sender,direction,text,media";
					const rows = messages.map((m) => {
						const direction = m.is_outgoing ? "sent" : "received";
						const text = (m.text ?? "").replace(/"/g, '""').replace(/\n/g, "\\n");
						const media = (m.media_desc ?? "").replace(/"/g, '""');
						return `${m.id},"${m.date_iso}","${m.sender_id ?? ""}","${direction}","${text}","${media}"`;
					});
					output = [header, ...rows].join("\n");
					break;
				}

				case "txt": {
					const lines = messages.map((m) => {
						const date = new Date(m.date_unix * 1000);
						const dateStr = date.toLocaleString("en-US", {
							year: "numeric",
							month: "short",
							day: "numeric",
							hour: "2-digit",
							minute: "2-digit",
						});
						const direction = m.is_outgoing ? "You" : contact.displayName;
						const text = m.text || m.media_desc || "(no content)";
						return `[${dateStr}] ${direction}: ${text}`;
					});
					output = lines.join("\n");
					break;
				}

				default:
					return;
			}

			if (opts.output) {
				await Bun.write(opts.output, output);
				p.log.success(`Exported ${formatNumber(messages.length)} messages to ${opts.output}`);
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
