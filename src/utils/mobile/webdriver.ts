import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "mobile.webdriver" });

/**
 * The first `POST /session` builds WebDriverAgent with xcodebuild and can take minutes, past any normal HTTP timeout.
 */
export const APPIUM_SESSION_TIMEOUT_MS = 600_000;

interface WebDriverReply<T> {
    value: T & { error?: string; message?: string };
}

/**
 * A minimal W3C WebDriver client for an Appium server: the few calls a screenshot tour needs, over plain `fetch`, so a
 * tool can drive a simulator without webdriverio in its dependency tree.
 */
export class AppiumSession {
    private constructor(
        private readonly base: string,
        readonly id: string
    ) {}

    static async create(options: {
        port: number;
        capabilities: Record<string, unknown>;
        timeoutMs?: number;
    }): Promise<AppiumSession> {
        const base = `http://127.0.0.1:${options.port}`;
        const started = performance.now();
        const reply = await call<{ sessionId: string }>({
            url: `${base}/session`,
            method: "POST",
            body: { capabilities: { alwaysMatch: options.capabilities, firstMatch: [{}] } },
            timeoutMs: options.timeoutMs ?? APPIUM_SESSION_TIMEOUT_MS,
        });
        log.debug({ sessionId: reply.sessionId, ms: Math.round(performance.now() - started) }, "appium session");
        return new AppiumSession(base, reply.sessionId);
    }

    private url(path: string): string {
        return `${this.base}/session/${this.id}${path}`;
    }

    execute(script: string, args: Record<string, unknown>): Promise<unknown> {
        return call({ url: this.url("/execute/sync"), method: "POST", body: { script, args: [args] } });
    }

    /** True when an element with this accessibility id (a React Native testID) exists right now. */
    async exists(accessibilityId: string): Promise<boolean> {
        try {
            await call({
                url: this.url("/element"),
                method: "POST",
                body: { using: "accessibility id", value: accessibilityId },
            });
            return true;
        } catch (error) {
            log.debug({ accessibilityId, error }, "element not found yet");
            return false;
        }
    }

    /** Waits until the element exists; false when the deadline passes first. */
    async waitForExist(accessibilityId: string, timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (await this.exists(accessibilityId)) {
                return true;
            }

            await Bun.sleep(Math.min(500, Math.max(0, deadline - Date.now())));
        }

        return false;
    }

    /**
     * Dismisses every open system alert (an "Open in <app>?" prompt, a permission ask), up to `max`, and returns how
     * many it dismissed. iOS queues them, so one dismissal can reveal the next.
     */
    async dismissAlerts(max = 30): Promise<number> {
        let dismissed = 0;
        while (dismissed < max) {
            try {
                await call({ url: this.url("/alert/text"), method: "GET" });
            } catch (error) {
                log.debug({ error, dismissed }, "no alert open");
                return dismissed;
            }

            await call({ url: this.url("/alert/dismiss"), method: "POST", body: {} });
            dismissed++;
        }

        return dismissed;
    }

    /** The screen as PNG bytes. */
    async screenshot(): Promise<Uint8Array> {
        const base64 = await call<string>({ url: this.url("/screenshot"), method: "GET" });
        return Uint8Array.from(Buffer.from(base64, "base64"));
    }

    async close(): Promise<void> {
        try {
            await call({ url: this.url(""), method: "DELETE" });
        } catch (error) {
            log.warn({ sessionId: this.id, error }, "appium session close failed");
        }
    }
}

async function call<T>(options: { url: string; method: string; body?: unknown; timeoutMs?: number }): Promise<T> {
    const response = await fetch(options.url, {
        method: options.method,
        headers: { "content-type": "application/json" },
        body: options.body === undefined ? undefined : SafeJSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
    const reply = SafeJSON.parse(await response.text(), { strict: true }) as WebDriverReply<T>;

    if (!response.ok || reply.value?.error) {
        throw new Error(
            `${options.method} ${options.url}: ${reply.value?.error ?? response.status} ${reply.value?.message ?? ""}`.trim()
        );
    }

    return reply.value;
}
