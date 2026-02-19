import type { NewMessageEvent } from "telegram/events";
import pc from "picocolors";
import logger from "@app/logger";
import type { TGClient } from "./TGClient";
import { TelegramMessage } from "./TelegramMessage";
import { TelegramContact } from "./TelegramContact";
import type { ContactConfig } from "./types";
import { DEFAULTS } from "./types";
import { executeActions } from "./actions";

const processedIds = new Set<number>();
const processedOrder: number[] = [];

function trackMessage(id: number): boolean {
	if (processedIds.has(id)) {
		return false;
	}

	processedIds.add(id);
	processedOrder.push(id);

	while (processedOrder.length > DEFAULTS.maxProcessedMessages) {
		const oldest = processedOrder.shift();

		if (oldest !== undefined) {
			processedIds.delete(oldest);
		}
	}

	return true;
}

export function registerHandler(client: TGClient, contacts: ContactConfig[]): void {
	const contactMap = new Map<string, TelegramContact>();

	for (const config of contacts) {
		const contact = TelegramContact.fromConfig(config);
		contactMap.set(config.userId, contact);
	}

	client.onNewMessage(async (event: NewMessageEvent) => {
		try {
			const msg = new TelegramMessage(event.message);

			if (!msg.isPrivate || msg.isOutgoing) {
				return;
			}

			const senderId = msg.senderId;

			if (!senderId) {
				return;
			}

			const contact = contactMap.get(senderId);

			if (!contact) {
				return;
			}

			if (!trackMessage(msg.id)) {
				return;
			}

			if (!msg.hasText && !msg.hasMedia) {
				return;
			}

			logger.info(`${pc.bold(pc.cyan(contact.displayName))}: ${msg.preview}`);

			const results = await executeActions(contact, msg, client);

			for (const r of results) {
				if (r.success) {
					const extra = r.reply
						? ` "${r.reply.slice(0, 60)}${r.reply.length > 60 ? "..." : ""}"`
						: "";
					logger.info(`  ${pc.green(`[${r.action}]`)} OK${pc.dim(extra)}`);
				} else {
					logger.warn(`  ${pc.red(`[${r.action}]`)} FAILED: ${r.error}`);
				}
			}
		} catch (err) {
			logger.error(`Handler error: ${err}`);
		}
	});

	const names = contacts.map((c) => pc.cyan(c.displayName)).join(", ");
	logger.info(`Listening for messages from ${contacts.length} contact(s): ${names}`);
}
