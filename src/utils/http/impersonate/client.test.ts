import { describe, expect, test } from "bun:test";
import { ImpersonatedHttpClient, type ImpersonateEngine } from "./client";

/** Workers that never answer a request; each start waits until the test releases it. No library, no thread. */
class HeldEngines extends ImpersonatedHttpClient {
    readonly releases: Array<() => void> = [];
    readonly posted: unknown[][] = [];

    protected override start(): Promise<ImpersonateEngine> {
        const messages: unknown[] = [];
        this.posted.push(messages);
        let markClosed = () => {};
        const engine: ImpersonateEngine = {
            worker: {
                postMessage: (message: unknown) => {
                    messages.push(message);
                    if (
                        typeof message === "object" &&
                        message !== null &&
                        "type" in message &&
                        message.type === "close"
                    ) {
                        markClosed();
                    }
                },
                terminate: () => {},
            },
            wakeup: () => {},
            closed: new Promise<void>((resolve) => {
                markClosed = resolve;
            }),
        };
        return new Promise((resolve) => {
            this.releases.push(() => resolve(engine));
        });
    }
}

describe("ImpersonatedHttpClient workers", () => {
    test("close() ends the requests of its own worker, never those of the worker that replaced it", async () => {
        const client = new HeldEngines({ label: "test" });
        const first = client.request({ url: "https://example.com/a" }).then(
            () => "answered",
            (error: Error) => error.message
        );
        // close() gives up the first worker while it still starts; the next request starts a second one.
        const closing = client.close();
        const controller = new AbortController();
        let secondSettled = false;
        const second = client.request({ url: "https://example.com/b", signal: controller.signal }).then(
            () => "answered",
            (error: Error) => {
                secondSettled = true;
                return error.message;
            }
        );
        client.releases[1]?.();
        await Bun.sleep(0);
        client.releases[0]?.();
        await closing;

        expect(await first).toMatch(/impersonate client closed/);
        expect(secondSettled).toBe(false);
        expect(client.posted[1]).toContainEqual(
            expect.objectContaining({ type: "request", url: "https://example.com/b" })
        );
        expect(client.posted[0]).toEqual([{ type: "close" }]);
        controller.abort();
        expect(await second).toMatch(/aborted/);
    });
});
