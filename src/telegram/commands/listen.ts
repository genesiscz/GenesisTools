import type { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import logger from "@app/logger";
import { TelegramToolConfig } from "../lib/TelegramToolConfig";
import { TGClient } from "../lib/TGClient";
import { TelegramMessage } from "../lib/TelegramMessage";
import { TelegramHistoryStore } from "../lib/TelegramHistoryStore";
import { registerHandler } from "../lib/handler";
import { DEFAULTS } from "../lib/types";
import type { ContactConfig } from "../lib/types";

async function syncAndLoadHistory(
	client: TGClient,
	store: TelegramHistoryStore,
	contacts: ContactConfig[],
	myName: string,
): Promise<Map<string, string[]>> {
	const historyMap = new Map<string, string[]>();

	for (const contact of contacts) {
		try {
			// Fetch recent messages from Telegram API and persist to DB
			const fetched = [];

			for await (const rawMsg of client.getMessages(contact.userId, { limit: DEFAULTS.historyFetchLimit })) {
				fetched.push(new TelegramMessage(rawMsg));
			}

			if (fetched.length > 0) {
				const serialized = fetched.map((m) => m.toJSON());
				const inserted = store.insertMessages(contact.userId, serialized);

				if (inserted > 0) {
					logger.info(`  ${pc.cyan(contact.displayName)}: ${inserted} new messages stored`);
				}
			}

			// Read back from DB for context (chronological order, last N)
			const messages = store.getByDateRange(contact.userId, undefined, undefined, DEFAULTS.historyFetchLimit);
			const lines: string[] = [];

			for (const msg of messages) {
				const content = msg.text || msg.media_desc;

				if (!content) {
					continue;
				}

				const name = msg.is_outgoing ? myName : contact.displayName;
				lines.push(`${name}: ${content}`);
			}

			historyMap.set(contact.userId, lines);
			logger.info(`  ${pc.cyan(contact.displayName)}: ${lines.length} messages loaded for context`);
		} catch (err) {
			logger.warn(`  ${pc.cyan(contact.displayName)}: failed to sync history: ${err}`);
			historyMap.set(contact.userId, []);
		}
	}

	return historyMap;
}

export function registerListenCommand(program: Command): void {
	program
		.command("listen")
		.description("Start listening for messages from configured contacts")
		.action(async () => {
			const config = new TelegramToolConfig();
			const data = await config.load();

			if (!data?.session) {
				p.log.error("Not configured. Run: tools telegram configure");
				process.exit(1);
			}

			if (data.contacts.length === 0) {
				p.log.warn("No contacts configured. Run: tools telegram configure");
				process.exit(1);
			}

			const spinner = p.spinner();
			spinner.start("Connecting to Telegram...");

			const client = TGClient.fromConfig(config);
			const authorized = await client.connect();

			if (!authorized) {
				spinner.stop("Session expired");
				p.log.error("Session expired. Run: tools telegram configure");
				process.exit(1);
			}

			const me = await client.getMe();
			const myName = me.firstName || "Me";
			spinner.stop(`Connected as ${myName}`);

			const store = new TelegramHistoryStore();
			store.open();

			const historySpinner = p.spinner();
			historySpinner.start("Syncing conversation history...");

			const initialHistory = await syncAndLoadHistory(client, store, data.contacts, myName);

			historySpinner.stop("Conversation history synced");

			for (const c of data.contacts) {
				logger.info(
					`Watching: ${pc.cyan(c.displayName)} → [${c.actions.map((a) => pc.yellow(a)).join(", ")}]`,
				);
			}

			registerHandler(client, {
				contacts: data.contacts,
				myName,
				initialHistory,
				store,
			});
			logger.info(`Press ${pc.dim("Ctrl+C")} to stop.`);

			const shutdown = async () => {
				logger.info("Shutting down...");
				store.close();

				try {
					await client.disconnect();
				} catch {
					// ignore disconnect errors
				}

				process.exit(0);
			};

			process.on("SIGINT", shutdown);
			process.on("SIGTERM", shutdown);

			await new Promise(() => {});
		});
}
