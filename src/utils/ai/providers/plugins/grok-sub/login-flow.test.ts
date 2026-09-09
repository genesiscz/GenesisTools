import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "@genesiscz/utils/browser";
import { SafeJSON } from "@genesiscz/utils/json";
import { GROK_OIDC_CLIENT_ID, GROK_OIDC_ISSUER, GROK_REDIRECT_URI } from "../../../grok/oauth";
import {
    type CallbackListener,
    type CallbackListenerOptions,
    type StartCallbackListener,
    startCallbackListener,
} from "../../../oauth/callback-server";
import type { AccountFlowContext } from "../../account-features";
import { grokLogin } from "./login";

/**
 * The outward-facing call this file must never make: `presentAuthorizationUrl` reaches
 * `Browser.open` whenever `openUrl` is not injected. The spy THROWS as well as records.
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

function jwt(claims: Record<string, unknown>): string {
    return `e30.${Buffer.from(SafeJSON.stringify(claims), "utf-8").toString("base64url").replace(/=+$/, "")}.sig`;
}

const EXP = Math.floor(Date.now() / 1000) + 3_600;
const ACCESS = jwt({ sub: "user-1111", exp: EXP, tier: 5, team_id: "team-2222" });
const ID_TOKEN = jwt({ sub: "user-1111", email: "alice@example.com" });

function setup(options: { status?: number } = {}) {
    const home = mkdtempSync(join(tmpdir(), "gt-grok-login-flow-"));
    const requests: string[] = [];
    const realFetch = globalThis.fetch;
    const response: typeof fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const target = String(input);

            // The loopback callback listener is a real socket in these tests.
            if (target.startsWith("http://127.0.0.1:")) {
                return realFetch(input, init);
            }

            if (target !== "https://auth.x.ai/oauth2/token") {
                throw new Error(`Unexpected network request ${target}`);
            }

            requests.push(new URLSearchParams(String(init?.body)).get("code") ?? "");
            return new Response(
                SafeJSON.stringify({ access_token: ACCESS, refresh_token: "refresh-invented", id_token: ID_TOKEN }),
                { status: options.status ?? 200 }
            );
        },
        { preconnect: globalThis.fetch.preconnect }
    );
    const network = spyOn(globalThis, "fetch").mockImplementation(response);
    restoreFetch = () => network.mockRestore();
    const opened: string[] = [];
    const ctx: AccountFlowContext = {
        interactive: true,
        requestedName: "work",
        openUrl: async (url) => {
            opened.push(url);
        },
        authorizationInteraction: { chooseUrlAction: async () => "none", readCode: async () => "grant-invented" },
    };

    return { ctx, home, requests, opened };
}

/** Port 2419 already taken: the paste prompt is the whole flow. */
const noListener: StartCallbackListener = async () => null;

/** A bind probe is never called back, so it has nothing to refuse. */
const neverCalledBack = (): undefined => undefined;

async function expectPortReleased(port: number): Promise<void> {
    const probe = await startCallbackListener({ redirectUri: GROK_REDIRECT_URI, port, verifyState: neverCalledBack });
    expect(probe).not.toBeNull();
    await probe?.close();
}

/** The real listener on an ephemeral port; production binds the CLI's fixed 2419. */
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

/** Drives the flow up to the point where the browser would hit the callback. */
function browserLogin(ctx: AccountFlowContext, overrides: Partial<CallbackListenerOptions> = {}) {
    let listener: CallbackListener | undefined;
    let opened!: (url: string) => void;
    const authUrl = new Promise<string>((resolve) => {
        opened = resolve;
    });
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
    const outcome = grokLogin(
        ctx,
        ephemeralListener((started) => {
            listener = started;
        }, overrides)
    );
    outcome.catch(() => undefined);

    return {
        outcome,
        async callback(query: (state: string) => string): Promise<Response> {
            const state = new URL(await authUrl).searchParams.get("state") ?? "";

            if (!listener) {
                throw new Error("the listener must be up before the browser is sent anywhere");
            }

            return fetch(`http://127.0.0.1:${listener.port}/callback?${query(state)}`);
        },
        get port(): number {
            if (!listener) {
                throw new Error("no listener was started");
            }

            return listener.port;
        },
    };
}

describe("Grok browser login", () => {
    test("a pasted callback with the matching state becomes a vault grant with the token's identity", async () => {
        const { ctx, requests } = setup();
        let state = "";
        ctx.openUrl = async (url) => {
            state = new URL(url).searchParams.get("state") ?? "";
        };
        ctx.authorizationInteraction = {
            chooseUrlAction: async () => "open",
            readCode: async () => `${GROK_REDIRECT_URI}?code=callback-grant&state=${state}`,
        };

        const outcome = await grokLogin(ctx, noListener);

        expect(requests).toEqual(["callback-grant"]);
        expect(outcome.provider).toBe("grok-sub");
        expect(outcome.credentials).toEqual({
            authFile: "",
            accessToken: ACCESS,
            refreshToken: "refresh-invented",
            expiresAt: EXP * 1000,
        });
        expect(outcome.identity).toEqual({ email: "alice@example.com", accountUuid: "user-1111", plan: "tier 5" });
        expect(outcome.suggestedName).toBe("alice");
        expect(outcome.accountFields).toEqual({ accountUuid: "user-1111", label: "tier 5" });
        expect(outcome.rollback).toBeUndefined();
    });

    test("a mismatched state never reaches the token exchange", async () => {
        const { ctx, requests } = setup();
        ctx.authorizationInteraction = {
            chooseUrlAction: async () => "none",
            readCode: async () => "callback-grant#wrong-state",
        };

        await expect(grokLogin(ctx, noListener)).rejects.toThrow(/state/i);
        expect(requests).toEqual([]);
    });

    test("cancelling the code prompt exchanges nothing", async () => {
        const { ctx, requests } = setup();
        ctx.authorizationInteraction = { chooseUrlAction: async () => "none", readCode: async () => null };

        await expect(grokLogin(ctx, noListener)).rejects.toThrow("Cancelled");
        expect(requests).toEqual([]);
    });

    test("a refused exchange is reported as such", async () => {
        const { ctx, requests } = setup({ status: 400 });

        await expect(grokLogin(ctx, noListener)).rejects.toThrow(/token exchange failed/i);
        expect(requests).toEqual(["grant-invented"]);
    });

    test("needs a TTY", async () => {
        const { ctx, requests } = setup();

        await expect(grokLogin({ ...ctx, interactive: false }, noListener)).rejects.toThrow(/TTY/);
        expect(requests).toEqual([]);
    });

    test.each(["home", "authFile"] as const)(
        "an explicit %s writes the Grok CLI's own auth file, with rollback",
        async (option) => {
            const { ctx, home } = setup();
            const authFile = join(home, "auth.json");
            writeFileSync(authFile, "native credential sentinel");

            const outcome = await grokLogin({ ...ctx, ...(option === "home" ? { home } : { authFile }) }, noListener);

            expect(outcome.credentials).toEqual({ authFile });
            const document = SafeJSON.parse(readFileSync(authFile, "utf-8"), { strict: true }) as Record<
                string,
                { key?: string }
            >;
            expect(document[`${GROK_OIDC_ISSUER}::${GROK_OIDC_CLIENT_ID}`]?.key).toBe(ACCESS);
            expect(outcome.rollback).toBeDefined();
            await outcome.rollback?.();
            expect(readFileSync(authFile, "utf8")).toBe("native credential sentinel");
        }
    );

    test("a missing explicit auth file is created, and rollback removes it again", async () => {
        const { ctx, home } = setup();
        const authFile = join(home, "fresh", "auth.json");

        const outcome = await grokLogin({ ...ctx, authFile }, noListener);

        expect(existsSync(authFile)).toBe(true);
        await outcome.rollback?.();
        expect(existsSync(authFile)).toBe(false);
    });
});

describe("Grok loopback callback listener", () => {
    test("the browser callback with the matching state completes the login and releases the port", async () => {
        const { ctx, requests } = setup();
        const flow = browserLogin(ctx);

        const response = await flow.callback((state) => `code=callback-grant&state=${state}`);

        expect(response.status).toBe(200);
        const outcome = await flow.outcome;
        expect(outcome.credentials.accessToken).toBe(ACCESS);
        expect(requests).toEqual(["callback-grant"]);
        await expectPortReleased(flow.port);
    });

    test("a foreign loopback request cannot end the login", async () => {
        const { ctx, requests } = setup();
        const flow = browserLogin(ctx);

        const refused = await flow.callback(() => "code=foreign-grant&state=wrong-state");
        expect(refused.status).toBe(400);
        expect(requests).toEqual([]);

        const accepted = await flow.callback((state) => `code=callback-grant&state=${state}`);
        expect(accepted.status).toBe(200);
        expect((await flow.outcome).credentials.accessToken).toBe(ACCESS);
        expect(requests).toEqual(["callback-grant"]);
        await expectPortReleased(flow.port);
    });

    test("an abandoned browser falls back to the paste prompt", async () => {
        const { ctx, requests } = setup();
        let listener: CallbackListener | undefined;
        ctx.authorizationInteraction = { chooseUrlAction: async () => "open", readCode: async () => "pasted-grant" };

        const outcome = await grokLogin(
            ctx,
            ephemeralListener(
                (started) => {
                    listener = started;
                },
                { timeoutMs: 25 }
            )
        );

        expect(outcome.credentials.accessToken).toBe(ACCESS);
        expect(requests).toEqual(["pasted-grant"]);

        if (listener) {
            await expectPortReleased(listener.port);
        }
    });
});
