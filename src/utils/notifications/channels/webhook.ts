import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { NotificationEvent, WebhookChannelConfig } from "../types";

export async function dispatchWebhook(event: NotificationEvent, config: WebhookChannelConfig): Promise<void> {
    if (!config.enabled || !config.url) {
        return;
    }

    try {
        await fetch(config.url, {
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
    } catch (err) {
        logger.warn({ err, app: event.app }, "Webhook notification dispatch failed");
    }
}
