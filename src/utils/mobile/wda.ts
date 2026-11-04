import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "mobile.wda" });

interface WdaReply<T> {
    value: T & { error?: string; message?: string };
}

/**
 * The WebDriverAgent routes that answer without a session, straight on the WDA port an Appium session pinned
 * (`wdaPortsFor(udid).wda`). They let a second actor (the alert watcher, a capture) read the screen while a wdio run
 * owns the one Appium session XCUITest allows per simulator: a second Appium session would end the first.
 */
export class WdaClient {
    constructor(readonly port: number) {}

    private async call<T>(options: { path: string; method?: string; body?: unknown; timeoutMs?: number }): Promise<T> {
        const url = `http://127.0.0.1:${this.port}${options.path}`;
        const response = await fetch(url, {
            method: options.method ?? "GET",
            headers: { "content-type": "application/json" },
            body: options.body === undefined ? undefined : SafeJSON.stringify(options.body),
            signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
        const reply = SafeJSON.parse(await response.text(), { strict: true }) as WdaReply<T>;

        if (!response.ok || reply.value?.error) {
            throw new WdaError(reply.value?.error ?? String(response.status), reply.value?.message ?? "");
        }

        return reply.value;
    }

    /** True when WDA answers on its port (it runs only while, or shortly after, an Appium session drove it). */
    async ready(): Promise<boolean> {
        try {
            await this.call({ path: "/status", timeoutMs: 2_000 });
            return true;
        } catch (error) {
            log.debug({ port: this.port, error }, "wda not answering");
            return false;
        }
    }

    /** The open alert's title and message, or null when no alert is open. */
    async alertText(): Promise<string | null> {
        try {
            return await this.call<string>({ path: "/alert/text" });
        } catch (error) {
            if (error instanceof WdaError && error.code === "no such alert") {
                return null;
            }

            throw error;
        }
    }

    /** Taps the alert button with this label. Throws when the alert has no such button. */
    async tapAlertButton(label: string): Promise<void> {
        await this.call({ path: "/alert/accept", method: "POST", body: { name: label } });
    }

    async dismissAlert(): Promise<void> {
        await this.call({ path: "/alert/dismiss", method: "POST", body: {} });
    }

    /** The accessibility tree as XCUITest XML. */
    source(): Promise<string> {
        return this.call<string>({ path: "/source", timeoutMs: 30_000 });
    }

    async screenshot(): Promise<Uint8Array> {
        const base64 = await this.call<string>({ path: "/screenshot", timeoutMs: 30_000 });
        return Uint8Array.from(Buffer.from(base64, "base64"));
    }
}

export class WdaError extends Error {
    constructor(
        readonly code: string,
        detail: string
    ) {
        super(`${code}${detail ? `: ${detail}` : ""}`);
    }
}
