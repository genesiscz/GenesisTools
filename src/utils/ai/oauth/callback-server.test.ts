import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { type CallbackListener, startCallbackListener } from "./callback-server";

const REDIRECT_URI = "http://localhost:1455/auth/callback";

/** The only honest "the listener is gone" assertion: the port takes a fresh bind. */
async function portIsFree(port: number): Promise<boolean> {
    try {
        const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("probe") });
        await probe.stop();
        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") {
            return false;
        }

        throw error;
    }
}

/** Stands in for the real flow's check: only `session` belongs to this sign-in. */
const acceptSession = (state: string | undefined): string | undefined =>
    state === "session" ? undefined : "this callback belongs to a different sign-in";

async function listening(): Promise<CallbackListener> {
    const listener = await startCallbackListener({ redirectUri: REDIRECT_URI, port: 0, verifyState: acceptSession });

    if (listener === null) {
        throw new Error("An ephemeral port must always bind");
    }

    return listener;
}

function callbackUrl(listener: CallbackListener, query: string): string {
    return `http://127.0.0.1:${listener.port}/auth/callback${query}`;
}

/** Raw request so the `Host` header can lie; `fetch` always sends the real authority. */
async function requestWithHost(port: number, host: string): Promise<string> {
    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("error", reject);
    });
    socket.write(`GET /auth/callback?code=grant&state=session HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    const status = await new Promise<string>((resolve) => {
        socket.once("data", (chunk) => resolve(String(chunk).split("\r\n")[0]));
    });
    socket.destroy();
    return status;
}

describe("loopback OAuth callback listener", () => {
    test("hands the flow the callback parameters and frees the port", async () => {
        const listener = await listening();
        const port = listener.port;
        expect(listener.hostname).toBe("127.0.0.1");
        const response = await fetch(callbackUrl(listener, "?code=grant&state=session"));
        const html = await response.text();
        expect(response.status).toBe(200);
        expect(html).toContain("You can close this tab");
        expect(html).not.toContain("mcp-manager");
        expect(await listener.callback).toEqual({ code: "grant", state: "session" });
        await listener.close();
        expect(await portIsFree(port)).toBe(true);
    });

    test.each([
        ["a wrong state", "?code=foreign-grant&state=wrong"],
        ["no state at all", "?code=foreign-grant"],
        ["a provider error with no state", "?error=access_denied&error_description=nope"],
    ] as const)("a foreign request with %s cannot consume the login", async (_label, query) => {
        const seen: Array<string | undefined> = [];
        const listener = await startCallbackListener({
            redirectUri: REDIRECT_URI,
            port: 0,
            verifyState: (state) => {
                seen.push(state);
                return acceptSession(state);
            },
        });

        if (listener === null) {
            throw new Error("An ephemeral port must always bind");
        }

        const refused = await fetch(callbackUrl(listener, query));
        expect(refused.status).toBe(400);
        // The listener is still up and still waiting, which is the whole point.
        const accepted = await fetch(callbackUrl(listener, "?code=real-grant&state=session"));
        expect(accepted.status).toBe(200);
        expect(await listener.callback).toEqual({ code: "real-grant", state: "session" });
        expect(seen).toHaveLength(2);
        await listener.close();
        expect(await portIsFree(listener.port)).toBe(true);
    });

    test.each([
        ["?error=access_denied&error_description=nope&state=session", /access_denied/],
        ["?state=session", /no .*code/i],
    ] as const)("reports an unusable callback %s as an error", async (query, expected) => {
        const listener = await listening();
        const response = await fetch(callbackUrl(listener, query));
        expect(response.status).toBe(400);
        const result = await listener.callback;
        expect(result).toHaveProperty("error");
        expect((result as { error: string }).error).toMatch(expected);
        await listener.close();
    });

    test("ignores paths the browser asks for on its own", async () => {
        const listener = await listening();
        expect((await fetch(`http://127.0.0.1:${listener.port}/favicon.ico`)).status).toBe(404);
        await fetch(callbackUrl(listener, "?code=grant&state=session"));
        expect(await listener.callback).toEqual({ code: "grant", state: "session" });
        await listener.close();
    });

    test("refuses a request that reached the socket under a foreign host name", async () => {
        const listener = await listening();
        expect(await requestWithHost(listener.port, "attacker.example")).toContain("403");
        expect(await requestWithHost(listener.port, `localhost:${listener.port}`)).toContain("200");
        expect(await listener.callback).toEqual({ code: "grant", state: "session" });
        await listener.close();
    });

    test("brands the success page when the caller owns it", async () => {
        const listener = await startCallbackListener({
            redirectUri: REDIRECT_URI,
            port: 0,
            verifyState: acceptSession,
            brand: { app: "GenesisTools", product: "mcp-manager" },
        });

        if (listener === null) {
            throw new Error("An ephemeral port must always bind");
        }

        const html = await (await fetch(callbackUrl(listener, "?code=grant&state=session"))).text();
        expect(html).toContain("Signed in");
        expect(html).toContain("GenesisTools");
        expect(html).toContain("mcp-manager");
        expect(html).toContain("<svg");
        await listener.close();
    });

    test("serves exactly one callback", async () => {
        const listener = await listening();
        await fetch(callbackUrl(listener, "?code=first&state=session"));
        const second = await fetch(callbackUrl(listener, "?code=second&state=session"));
        expect(second.status).toBe(410);
        expect(await listener.callback).toEqual({ code: "first", state: "session" });
        await listener.close();
    });

    test("an abandoned browser times out, resolves null and releases the port", async () => {
        const listener = await startCallbackListener({
            redirectUri: REDIRECT_URI,
            port: 0,
            timeoutMs: 25,
            verifyState: acceptSession,
        });

        if (listener === null) {
            throw new Error("An ephemeral port must always bind");
        }

        expect(await listener.callback).toBeNull();
        expect(await portIsFree(listener.port)).toBe(true);
        await listener.close();
    });

    test("close settles a pending callback as null and is idempotent", async () => {
        const listener = await listening();
        await listener.close();
        await listener.close();
        expect(await listener.callback).toBeNull();
        expect(await portIsFree(listener.port)).toBe(true);
    });

    test("a busy port yields no listener instead of failing the login", async () => {
        const held = await listening();
        const second = { redirectUri: REDIRECT_URI, port: held.port, verifyState: acceptSession };
        expect(await startCallbackListener(second)).toBeNull();
        await held.close();
    });

    test("takes the port and path from the registered redirect URI", async () => {
        const listener = await startCallbackListener({
            redirectUri: "http://localhost:1455/oauth/done",
            port: 0,
            verifyState: acceptSession,
        });

        if (listener === null) {
            throw new Error("An ephemeral port must always bind");
        }

        const wrongPath = `http://127.0.0.1:${listener.port}/auth/callback?code=grant&state=session`;
        expect((await fetch(wrongPath)).status).toBe(404);
        expect((await fetch(`http://127.0.0.1:${listener.port}/oauth/done?code=grant&state=session`)).status).toBe(200);
        expect(await listener.callback).toEqual({ code: "grant", state: "session" });
        await listener.close();
    });
});
