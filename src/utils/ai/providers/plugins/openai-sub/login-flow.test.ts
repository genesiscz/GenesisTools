import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "@genesiscz/utils/browser";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    type CallbackListener,
    type CallbackListenerOptions,
    type StartCallbackListener,
    startCallbackListener,
} from "../../../oauth/callback-server";
import { CODEX_REDIRECT_URI, codexOAuth } from "../../../openai/codex-auth";
import type { AccountFlowContext } from "../../account-features";
import { codexLogin } from "./login";

/**
 * The outward-facing call this file must never make. `presentAuthorizationUrl`
 * reaches `Browser.open` whenever `openUrl` is not injected, which on 2026-09-09
 * put real `auth.openai.com` tabs in front of the user on every suite run. The
 * spy THROWS as well as records, so a forgotten injection is a red test rather
 * than a browser window nobody asked for.
 */
let browserGuard: ReturnType<typeof spyOn<typeof Browser, "open">> | undefined;
beforeAll(() => {
    browserGuard = spyOn(Browser, "open").mockImplementation(async (url: string) => {
        throw new Error(`a test reached the real browser with ${url}`);
    });
});
afterAll(() => {
    browserGuard?.mockRestore();
});

let restoreFetch: (() => void) | undefined;
afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
});

function setup(options: { status?: number } = {}) {
    const home = mkdtempSync(join(tmpdir(), "gt-codex-login-flow-"));
    const authFile = join(home, "auth.json");
    writeFileSync(authFile, "native credential sentinel");
    const requests: string[] = [];
    const realFetch = globalThis.fetch;
    const response: typeof fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const target = String(input);

            // The loopback callback listener is a real socket in these tests.
            if (target.startsWith("http://127.0.0.1:")) {
                return realFetch(input, init);
            }

            if (target !== "https://auth.openai.com/oauth/token") {
                throw new Error("Unexpected network request");
            }

            const body = SafeJSON.parse(String(init?.body)) as { code: string };
            requests.push(body.code);
            return new Response(
                SafeJSON.stringify({
                    access_token: "access-invented",
                    refresh_token: "refresh-invented",
                    expires_in: 3600,
                    id_token: `header.${Buffer.from(SafeJSON.stringify({ chatgpt_account_id: "account-invented" })).toString("base64url")}.signature`,
                }),
                { status: options.status ?? 200 }
            );
        },
        { preconnect: globalThis.fetch.preconnect }
    );
    const network = spyOn(globalThis, "fetch").mockImplementation(response);
    restoreFetch = () => network.mockRestore();
    // 🛑 No test in this file may reach a real browser. `presentAuthorizationUrl`
    // falls through to `Browser.open` whenever `openUrl` is absent, so a test that
    // picks "open" and forgets to inject one opens `auth.openai.com` for real. This
    // is set here, not per test, so forgetting is not possible.
    const opened: string[] = [];
    const ctx: AccountFlowContext = {
        interactive: true,
        requestedName: "work",
        openUrl: async (url) => {
            opened.push(url);
        },
        account: {
            id: "acc_work",
            name: "work",
            provider: "openai-sub",
            enabled: true,
            billing: { mode: "subscription" },
            credentials: { authFile },
            useEnvApiKey: false,
        },
        authorizationInteraction: { chooseUrlAction: async () => "none", readCode: async () => "grant-invented" },
    };
    return { ctx, home, authFile, requests, opened };
}

/** Every authorization URL a flow would have opened must be the one we generated. */
function expectAuthorizeUrl(opened: string[]): void {
    expect(opened).toHaveLength(1);
    expect(opened[0]).toStartWith("https://auth.openai.com/oauth/authorize?");
}

/** Port 1455 already taken: exactly what every caller saw before the listener existed. */
const noListener: StartCallbackListener = async () => null;

/**
 * The real listener, on an ephemeral port. Production binds the vendor's fixed
 * 1455; a test that bound it would collide with a real `codex login`.
 */
function ephemeralListener(
    capture: (listener: CallbackListener) => void,
    overrides: Partial<CallbackListenerOptions> = {}
): StartCallbackListener {
    return async (options) => {
        const listener = await startCallbackListener({ ...options, ...overrides, port: 0 });

        if (listener) {
            capture(listener);
        }

        return listener;
    };
}

/** Binding the same port again is the only honest proof the listener is gone. */
async function expectPortReleased(port: number): Promise<void> {
    const probe = await startCallbackListener({ redirectUri: CODEX_REDIRECT_URI, port });
    expect(probe).not.toBeNull();
    await probe?.close();
}

/** Drives the flow up to the point where the browser would hit the callback. */
function browserLogin(ctx: AccountFlowContext, overrides: Partial<CallbackListenerOptions> = {}) {
    let listener: CallbackListener | undefined;
    let opened!: (url: string) => void;
    const authUrl = new Promise<string>((resolve) => {
        opened = resolve;
    });
    // Wrap rather than replace, so the recorder `setup` installed stays in place
    // and no path can fall through to the real browser.
    const recorder = ctx.openUrl;
    ctx.openUrl = async (url) => {
        await recorder?.(url);
        opened(url);
    };
    ctx.authorizationInteraction = {
        chooseUrlAction: async () => "open",
        readCode: async () => {
            throw new Error("the paste prompt must not run while the listener is up");
        },
    };
    const outcome = codexLogin(
        ctx,
        ephemeralListener((started) => {
            listener = started;
        }, overrides)
    );
    // The assertions attach after the browser request below, so a login that
    // rejects first would otherwise be reported as an unhandled rejection.
    outcome.catch(() => undefined);

    return {
        outcome,
        async callback(query: (state: string) => string): Promise<Response> {
            const state = new URL(await authUrl).searchParams.get("state") ?? "";

            if (!listener) {
                throw new Error("the listener must be up before the browser is sent anywhere");
            }

            return fetch(`http://127.0.0.1:${listener.port}/auth/callback?${query(state)}`);
        },
        get port(): number {
            if (!listener) {
                throw new Error("no listener was started");
            }

            return listener.port;
        },
    };
}

describe("Codex browser login", () => {
    test.each(["matching", "mismatched"] as const)("checks a %s callback state before token exchange", async (mode) => {
        const { ctx, requests } = setup();
        let state = "";
        ctx.openUrl = async (url) => {
            state = new URL(url).searchParams.get("state") ?? "";
        };
        ctx.authorizationInteraction = {
            chooseUrlAction: async () => "open",
            readCode: async () =>
                `http://localhost:1455/auth/callback?code=callback-grant&state=${mode === "matching" ? state : "wrong-state"}`,
        };
        if (mode === "matching") {
            const outcome = await codexLogin(ctx, noListener);
            expect(outcome.credentials.accessToken).toBe("access-invented");
            expect(requests).toEqual(["callback-grant"]);
        } else {
            await expect(codexLogin(ctx, noListener)).rejects.toThrow(/state/i);
            expect(requests).toEqual([]);
        }
    });

    test("code prompt cancellation never exchanges a grant", async () => {
        const { ctx, requests, authFile } = setup();
        ctx.authorizationInteraction = { chooseUrlAction: async () => "none", readCode: async () => null };
        await expect(codexLogin(ctx, noListener)).rejects.toThrow("Cancelled");
        expect(requests).toEqual([]);
        expect(readFileSync(authFile, "utf8")).toBe("native credential sentinel");
    });

    test("a failed token exchange is not reported as cancellation", async () => {
        const { ctx, requests, authFile } = setup({ status: 400 });
        await expect(codexLogin(ctx, noListener)).rejects.toThrow(/Token exchange failed/);
        expect(requests).toEqual(["grant-invented"]);
        expect(readFileSync(authFile, "utf8")).toBe("native credential sentinel");
    });

    test.each(["home", "authFile"] as const)(
        "an explicit %s opts into a rollback-capable native file grant",
        async (option) => {
            const { ctx, home, authFile } = setup();
            const outcome = await codexLogin({ ...ctx, ...(option === "home" ? { home } : { authFile }) }, noListener);
            expect(outcome.credentials.authFile).toBe(authFile);
            expect(outcome.credentials.accessToken).toBeUndefined();
            expect(readFileSync(authFile, "utf8")).toContain("access-invented");
            expect(outcome.rollback).toBeDefined();
            await outcome.rollback?.();
            expect(readFileSync(authFile, "utf8")).toBe("native credential sentinel");
        }
    );

    test("a missing explicit auth file still runs the native creation flow", async () => {
        const { ctx, home } = setup();
        const nativeHome = join(home, "explicit");
        mkdirSync(nativeHome);
        const authFile = join(nativeHome, "auth.json");
        const outcome = await codexLogin({ ...ctx, authFile }, noListener);
        expect(outcome.credentials.authFile).toBe(authFile);
        expect(readFileSync(authFile, "utf8")).toContain("access-invented");
    });

    test("--broker remains an alias for separate vault login", async () => {
        const { ctx, authFile } = setup();
        const outcome = await codexLogin({ ...ctx, codexBroker: true }, noListener);
        expect(outcome.credentials.authFile).toBe("");
        expect(outcome.credentials.accessToken).toBe("access-invented");
        expect(readFileSync(authFile, "utf8")).toBe("native credential sentinel");
    });

    test("defaults to a separate vault grant even for an existing file-bound account", async () => {
        const { ctx, authFile, requests } = setup();
        const outcome = await codexLogin(ctx, noListener);
        expect(outcome.credentials.authFile).toBe("");
        expect(outcome.credentials.accessToken).toBe("access-invented");
        expect(readFileSync(authFile, "utf8")).toBe("native credential sentinel");
        expect(requests).toEqual(["grant-invented"]);
        expect(outcome.rollback).toBeUndefined();
    });
});
describe("Codex loopback callback listener", () => {
    test("a browser callback completes the login with no paste at all", async () => {
        const { ctx, requests } = setup();
        const flow = browserLogin(ctx);
        const response = await flow.callback((state) => `code=callback-grant&state=${state}`);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("You can close this tab");
        const outcome = await flow.outcome;
        expect(outcome.credentials.accessToken).toBe("access-invented");
        expect(requests).toEqual(["callback-grant"]);
        await expectPortReleased(flow.port);
    });

    test("a mismatched callback state never reaches the token exchange", async () => {
        const { ctx, requests } = setup();
        const exchange = spyOn(codexOAuth, "exchangeCode").mockImplementation(async () => {
            throw new Error("a refused callback must never be exchanged");
        });
        try {
            const flow = browserLogin(ctx);
            const response = await flow.callback(() => "code=callback-grant&state=wrong-state");
            expect(response.status).toBe(400);
            await expect(flow.outcome).rejects.toThrow(/state/i);
            expect(exchange).not.toHaveBeenCalled();
            expect(requests).toEqual([]);
            await expectPortReleased(flow.port);
        } finally {
            exchange.mockRestore();
        }
    });

    test("an abandoned browser falls back to the paste prompt", async () => {
        const { ctx, requests, opened } = setup();
        let listener: CallbackListener | undefined;
        ctx.authorizationInteraction = {
            chooseUrlAction: async () => "open",
            readCode: async () => "pasted-grant",
        };
        const outcome = await codexLogin(
            ctx,
            ephemeralListener(
                (started) => {
                    listener = started;
                },
                { timeoutMs: 25 }
            )
        );
        expect(outcome.credentials.accessToken).toBe("access-invented");
        expect(requests).toEqual(["pasted-grant"]);
        expectAuthorizeUrl(opened);

        if (!listener) {
            throw new Error("the listener must have started");
        }

        await expectPortReleased(listener.port);
    });

    test("a taken port falls back to the paste prompt and still completes the login", async () => {
        const { ctx, requests, opened } = setup();
        const held = await startCallbackListener({ redirectUri: CODEX_REDIRECT_URI, port: 0 });

        if (!held) {
            throw new Error("An ephemeral port must always bind");
        }

        ctx.authorizationInteraction = { chooseUrlAction: async () => "open", readCode: async () => "pasted-grant" };
        const outcome = await codexLogin(ctx, (options) => startCallbackListener({ ...options, port: held.port }));
        expect(outcome.credentials.accessToken).toBe("access-invented");
        expect(requests).toEqual(["pasted-grant"]);
        expectAuthorizeUrl(opened);
        await held.close();
    });

    test("choosing 'I already have the code' releases the port instead of waiting", async () => {
        const { ctx, requests } = setup();
        let listener: CallbackListener | undefined;
        ctx.authorizationInteraction = { chooseUrlAction: async () => "none", readCode: async () => "pasted-grant" };
        const outcome = await codexLogin(
            ctx,
            ephemeralListener((started) => {
                listener = started;
            })
        );
        expect(outcome.credentials.accessToken).toBe("access-invented");
        expect(requests).toEqual(["pasted-grant"]);

        if (!listener) {
            throw new Error("the listener must have started");
        }

        await expectPortReleased(listener.port);
    });

    test("a failed token exchange still leaves no socket behind", async () => {
        const { ctx } = setup({ status: 400 });
        const flow = browserLogin(ctx);
        await flow.callback((state) => `code=callback-grant&state=${state}`);
        await expect(flow.outcome).rejects.toThrow(/Token exchange failed/);
        await expectPortReleased(flow.port);
    });
});
