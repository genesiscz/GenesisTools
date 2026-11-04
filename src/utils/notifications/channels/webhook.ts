import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { ChannelDefinition, NotificationEvent, WebhookChannelConfig } from "../types";

/** True when the endpoint accepted the event (or there was nothing to send). Never throws. */
export async function dispatchWebhook(event: NotificationEvent, config: WebhookChannelConfig): Promise<boolean> {
    if (!config.enabled || !config.url) {
        return true;
    }

    try {
        const response = await fetch(config.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify({
                app: event.app,
                title: event.title,
                message: event.message,
                subtitle: event.subtitle,
                timestamp: new Date().toISOString(),
            }),
        });

        if (!response.ok) {
            logger.warn(
                { status: response.status, statusText: response.statusText, url: config.url, app: event.app },
                "Webhook notification returned non-OK status"
            );
        }

        // Nothing reads the body, and an unread one holds its socket until GC.
        await response.body?.cancel().catch((cancelError) => {
            logger.debug({ cancelError, app: event.app }, "Webhook response body cancel failed");
        });

        return response.ok;
    } catch (err) {
        logger.warn({ err, app: event.app }, "Webhook notification dispatch failed");

        return false;
    }
}

/** The host of a webhook URL, safe to show and log; null when it is not a URL. */
function hostOf(url: string | undefined): string | null {
    try {
        return url ? new URL(url).host : null;
    } catch {
        return null;
    }
}

export const webhookChannel: ChannelDefinition<"webhook"> = {
    name: "webhook",
    label: "Webhook",
    defaults: { enabled: false },
    fields: { enabled: "boolean", url: "string" },
    secretKeys: ["url"],
    unusable: (config) => (config.url ? undefined : "no url"),
    describe: (config) => hostOf(config.url) ?? "no url",
    post: async (event, config) => ({ ok: await dispatchWebhook(event, config) }),
    // An endpoint keeps what it was sent; there is no retraction call to make.
    retract: async () => false,
};
