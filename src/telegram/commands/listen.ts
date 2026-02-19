import type { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import logger from "@app/logger";
import { TelegramToolConfig } from "../lib/TelegramToolConfig";
import { TGClient } from "../lib/TGClient";
import { registerHandler } from "../lib/handler";

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
			spinner.stop(`Connected as ${me.firstName || "user"}`);

			for (const c of data.contacts) {
				logger.info(
					`Watching: ${pc.cyan(c.displayName)} → [${c.actions.map((a) => pc.yellow(a)).join(", ")}]`,
				);
			}

			registerHandler(client, data.contacts);
			logger.info(`Press ${pc.dim("Ctrl+C")} to stop.`);

			const shutdown = async () => {
				logger.info("Shutting down...");

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
