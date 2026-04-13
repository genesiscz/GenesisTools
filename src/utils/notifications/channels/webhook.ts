import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { NotificationEvent, WebhookChannelConfig } from "../types";

export async function dispatchWebhook(event: NotificationEvent, config: WebhookChannelConfig): Promise<void> {
    if (!config.enabled || !config.url) {
        return;
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
                "Webhook notification returned non-OK status",
            );
        }
    } catch (err) {
        logger.warn({ err, app: event.app }, "Webhook notification dispatch failed");
    }
}
