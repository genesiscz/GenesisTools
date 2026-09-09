import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { AccountFlowContext } from "../../account-features";
import { codexLogin } from "./login";

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
    const response: typeof fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input) !== "https://auth.openai.com/oauth/token") {
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
    const ctx: AccountFlowContext = {
        interactive: true,
        requestedName: "work",
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
    return { ctx, home, authFile, requests };
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
            const outcome = await codexLogin(ctx);
            expect(outcome.credentials.accessToken).toBe("access-invented");
            expect(requests).toEqual(["callback-grant"]);
        } else {
            await expect(codexLogin(ctx)).rejects.toThrow(/state/i);
            expect(requests).toEqual([]);
        }
    });

    test("code prompt cancellation never exchanges a grant", async () => {
        const { ctx, requests, authFile } = setup();
        ctx.authorizationInteraction = { chooseUrlAction: async () => "none", readCode: async () => null };
        await expect(codexLogin(ctx)).rejects.toThrow("Cancelled");
        expect(requests).toEqual([]);
        expect(readFileSync(authFile, "utf8")).toBe("native credential sentinel");
    });

    test("a failed token exchange is not reported as cancellation", async () => {
        const { ctx, requests, authFile } = setup({ status: 400 });
        await expect(codexLogin(ctx)).rejects.toThrow(/Token exchange failed/);
        expect(requests).toEqual(["grant-invented"]);
        expect(readFileSync(authFile, "utf8")).toBe("native credential sentinel");
    });

    test.each([
        "home",
        "authFile",
    ] as const)("an explicit %s opts into a rollback-capable native file grant", async (option) => {
        const { ctx, home, authFile } = setup();
        const outcome = await codexLogin({ ...ctx, ...(option === "home" ? { home } : { authFile }) });
        expect(outcome.credentials.authFile).toBe(authFile);
        expect(outcome.credentials.accessToken).toBeUndefined();
        expect(readFileSync(authFile, "utf8")).toContain("access-invented");
        expect(outcome.rollback).toBeDefined();
        await outcome.rollback?.();
        expect(readFileSync(authFile, "utf8")).toBe("native credential sentinel");
    });

    test("a missing explicit auth file still runs the native creation flow", async () => {
        const { ctx, home } = setup();
        const nativeHome = join(home, "explicit");
        mkdirSync(nativeHome);
        const authFile = join(nativeHome, "auth.json");
        const outcome = await codexLogin({ ...ctx, authFile });
        expect(outcome.credentials.authFile).toBe(authFile);
        expect(readFileSync(authFile, "utf8")).toContain("access-invented");
    });

    test("--broker remains an alias for separate vault login", async () => {
        const { ctx, authFile } = setup();
        const outcome = await codexLogin({ ...ctx, codexBroker: true });
        expect(outcome.credentials.authFile).toBe("");
        expect(outcome.credentials.accessToken).toBe("access-invented");
        expect(readFileSync(authFile, "utf8")).toBe("native credential sentinel");
    });

    test("defaults to a separate vault grant even for an existing file-bound account", async () => {
        const { ctx, authFile, requests } = setup();
        const outcome = await codexLogin(ctx);
        expect(outcome.credentials.authFile).toBe("");
        expect(outcome.credentials.accessToken).toBe("access-invented");
        expect(readFileSync(authFile, "utf8")).toBe("native credential sentinel");
        expect(requests).toEqual(["grant-invented"]);
        expect(outcome.rollback).toBeUndefined();
    });
});
