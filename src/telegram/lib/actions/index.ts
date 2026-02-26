import type { TelegramContact } from "../TelegramContact";
import type { TelegramMessage } from "../TelegramMessage";
import type { TGClient } from "../TGClient";
import type { ActionHandler, ActionResult, ActionType } from "../types";
import { handleAsk } from "./ask";
import { handleNotify } from "./notify";
import { handleSay } from "./say";

const ACTION_HANDLERS: Record<ActionType, ActionHandler> = {
    say: handleSay,
    ask: handleAsk,
    notify: handleNotify,
};

export async function executeActions(
    contact: TelegramContact,
    message: TelegramMessage,
    client: TGClient,
    conversationHistory?: string
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
