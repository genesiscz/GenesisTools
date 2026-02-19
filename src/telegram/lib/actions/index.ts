import type { ActionHandler, ActionResult, ActionType } from "../types";
import type { TelegramMessage } from "../TelegramMessage";
import type { TelegramContact } from "../TelegramContact";
import type { TGClient } from "../TGClient";
import { handleSay } from "./say";
import { handleAsk } from "./ask";
import { handleNotify } from "./notify";

const ACTION_HANDLERS: Record<ActionType, ActionHandler> = {
	say: handleSay,
	ask: handleAsk,
	notify: handleNotify,
};

export async function executeActions(
	contact: TelegramContact,
	message: TelegramMessage,
	client: TGClient,
	conversationHistory?: string,
): Promise<ActionResult[]> {
	const results: ActionResult[] = [];

	for (const action of contact.actions) {
		const handler = ACTION_HANDLERS[action];

		if (!handler) {
			continue;
		}

		const result = await handler(message, contact, client, conversationHistory);
		results.push(result);
	}

	return results;
}
