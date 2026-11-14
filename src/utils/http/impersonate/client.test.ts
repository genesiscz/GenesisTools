import { describe, expect, test } from "bun:test";
import { ImpersonatedHttpClient, type ImpersonateEngine } from "./client";
import { ResponseHead } from "./response-head";

describe("ResponseHead", () => {
    const read = (callerFollows: boolean, lines: string[]) => {
        const head = new ResponseHead(callerFollows);
        for (const line of lines) {
            head.line(`${line}\r\n`);
        }

        return head;
    };

    test("a redirect with a Location that the caller follows ends before its body", () => {
        const head = read(true, [
            "HTTP/2 302",
            "Location: https://example.com/next",
            "Set-Cookie: a=1",
            "Set-Cookie: b=2",
            "",
        ]);
        expect(head).toMatchObject({ status: 302, redirect: true });
        expect(head.headers).toEqual({ location: "https://example.com/next", "set-cookie": "a=1, b=2" });
    });

    test("a redirect curl follows, a redirect without a Location and a page all keep their body", () => {
        expect(read(false, ["HTTP/1.1 301 Moved", "Location: /next", ""]).redirect).toBe(false);
        expect(read(true, ["HTTP/1.1 303 See Other", ""]).redirect).toBe(false);
        expect(read(true, ["HTTP/1.1 200 OK", "Location: /ignored", ""]).redirect).toBe(false);
    });

    test("only the last head counts: a proxy CONNECT before the answer, a page after a followed hop", () => {
        const tunnel = read(true, ["HTTP/1.1 200 Connection established", "", "HTTP/2 307", "location: /moved", ""]);
        expect(tunnel).toMatchObject({ status: 307, redirect: true, headers: { location: "/moved" } });

        const hop = read(false, [
            "HTTP/1.1 302 Found",
            "Location: /final",
            "",
            "HTTP/1.1 200 OK",
            "Content-Type: text/html",
            "",
        ]);
        expect(hop).toMatchObject({ status: 200, redirect: false, headers: { "content-type": "text/html" } });
    });
});

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
