import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
} from "@genesiscz/utils/security";
import { AiConfigStore } from "../../config/AiConfigStore";
import { type AccountEntry, CONFIG_VERSION } from "../../config/schema";
import type { WhamModelRecord } from "../../openai/sub-models";
import { openAiSubPlugin } from "./openai-sub";
import { listOpenAiSubModels, OPENAI_SUB_MODEL_LIST_TTL_MS, resetOpenAiSubModelLists } from "./openai-sub/models";

/**
 * The subscription plugins' `bind`. A Claude, Codex or Grok refresh token is single-use, so every
 * test here runs on a sandboxed home with invented accounts, a fake transport and a spy on the
 * refresh primitive that throws when a path reaches it unexpectedly.
 */

let home: string;

function jwt(payload: Record<string, unknown>): string {
    return `e30.${Buffer.from(SafeJSON.stringify(payload)).toString("base64url")}.test`;
}

function codexToken(workspace: string, marker: string, expires = Date.now() + 3_600_000): string {
    return jwt({
        exp: Math.floor(expires / 1000),
        marker,
        "https://api.openai.com/auth": { chatgpt_account_id: workspace },
    });
}

function saveConfig(accounts: AccountEntry[]): void {
    writeFileSync(
        join(home, ".genesis-tools/ai/config.json"),
        SafeJSON.stringify({ version: CONFIG_VERSION, accounts, defaults: {} })
    );
    AiConfigStore.invalidate();
}

function codexAccount(): AccountEntry {
    return {
        id: "acc_codex_work",
        name: "work",
        provider: "openai-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials: {
            accessToken: codexToken("workspace-a", "first"),
            refreshToken: "codex-refresh-1",
            expiresAt: Date.now() + 3_600_000,
        },
        accountUuid: "workspace-a",
        useEnvApiKey: false,
    };
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-subscription-bind-"));
    mkdirSync(join(home, ".genesis-tools/ai"), { recursive: true });
    env.testing.set("GENESIS_TOOLS_HOME", home);
    const key = Buffer.alloc(32, 23);
    _setMasterKeyProvidersForTest([
        { id: "env", available: async () => true, get: async () => key, getSync: () => key, set: async () => {} },
    ]);
    _resetSecretsForTest();
    resetOpenAiSubModelLists();
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    AiConfigStore.invalidate();
});

describe("openai-sub bind", () => {
    test("binding performs zero fetch calls, for real use and for a probe", async () => {
        const account = codexAccount();
        saveConfig([account]);
        const calls: string[] = [];
        const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
            calls.push(String(input));
            throw new Error(`bind reached the network: ${String(input)}`);
        }) as unknown as typeof fetch);
        const transport = (async (input: RequestInfo | URL): Promise<Response> => {
            calls.push(String(input));
            throw new Error(`bind reached the transport: ${String(input)}`);
        }) as typeof fetch;

        try {
            const real = await openAiSubPlugin.bind({ account, fetch: transport });
            const probe = await openAiSubPlugin.bind({ account, probe: true, fetch: transport });
            real.language("gpt-6.1-sol");
            probe.language("gpt-6.1-sol");
        } finally {
            fetchSpy.mockRestore();
        }

        expect(calls).toEqual([]);
    });

    test("the picker's live list is fetched once per account within ten minutes", async () => {
        const account = codexAccount();
        let now = 1_000_000;
        let fetched = 0;
        const record: WhamModelRecord = {
            slug: "gpt-fixture-live",
            displayName: "GPT Fixture Live",
            contextWindow: 100_000,
            visibility: "list",
        };
        const deps = {
            now: () => now,
            fetchRecords: async () => {
                fetched += 1;
                return [record, { ...record, slug: "gpt-fixture-hidden", visibility: "hide" as const }];
            },
        };

        const first = await listOpenAiSubModels(account, deps);
        now += OPENAI_SUB_MODEL_LIST_TTL_MS - 1;
        await listOpenAiSubModels(account, deps);

        expect(first.map((entry) => entry.id)).toEqual(["gpt-fixture-live"]);
        expect(fetched).toBe(1);

        now += 2;
        await listOpenAiSubModels(account, deps);
        expect(fetched).toBe(2);
    });

    test("an unreadable live list answers with the static catalog and is not kept", async () => {
        const account = codexAccount();
        let fetched = 0;
        const deps = {
            fetchRecords: async () => {
                fetched += 1;
                return null;
            },
        };

        const fallback = await listOpenAiSubModels(account, deps);
        await listOpenAiSubModels(account, deps);

        expect(fallback.length).toBeGreaterThan(0);
        expect(fallback.every((entry) => entry.source === "static")).toBe(true);
        expect(fetched).toBe(2);
    });
});
