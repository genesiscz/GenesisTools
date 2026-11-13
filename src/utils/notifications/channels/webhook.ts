import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { refuseHostEffectInTest } from "@genesiscz/utils/test-process";
import type { ChannelDefinition, NotificationEvent, WebhookChannelConfig } from "../types";

/**
 * A webhook aimed at a server the test itself started is not a host effect, so the test-process refusal lets it
 * through. Everything else leaves the machine, including the plausible-looking placeholder domains in fixtures, which
 * belong to somebody and would receive a real POST.
 */
export function isLoopbackUrl(url: string): boolean {
    try {
        const { hostname } = new URL(url);
        // `new URL("http://[::1]:3000").hostname` keeps the brackets, so the bare "::1" form never appears here. The
        // whole 127.0.0.0/8 range is loopback, not just .1, and a test is free to bind anywhere in it.
        return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
    } catch {
        // An unparseable URL reaches no server, so the dispatcher's own error path is the honest thing to let it hit.
        return true;
    }
}

/**
 * True when the endpoint accepted the event (or there was nothing to send). Never throws, except that it rejects in a
 * test process (and a child a test spawns) when the URL is not loopback.
 */
export async function dispatchWebhook(event: NotificationEvent, config: WebhookChannelConfig): Promise<boolean> {
    if (!config.enabled || !config.url) {
        return true;
    }

    if (!isLoopbackUrl(config.url)) {
        refuseHostEffectInTest(
            "The webhook notification channel",
            "Point it at a loopback server the test starts, or assert the event instead of posting it."
        );
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
