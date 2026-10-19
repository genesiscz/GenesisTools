import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { APICallError, RetryError } from "ai";
import { AiConfigStore } from "../config/AiConfigStore";
import { type AccountEntry, type AiConfigData, CONFIG_VERSION } from "../config/schema";
import type { AccountUsageSnapshot } from "../providers/account-features";
import type { ProviderBinding } from "../providers/plugin-types";
import { type AutoCandidate, autoAccountCandidates, isAccountRefusal, runWithAutoAccount } from "./auto-account";
import { ModelResolutionError, resolveModelTarget } from "./resolve";
import { isUnlisted } from "./types";

let home: string;

function account(id: string, name: string, overrides: Partial<AccountEntry> = {}): AccountEntry {
    return {
        id,
        name,
        provider: "anthropic-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials: {},
        useEnvApiKey: false,
        ...overrides,
    };
}

const ACCOUNTS: AccountEntry[] = [
    account("acc_max", "martin-max"),
    account("acc_max2", "martin-max-second"),
    account("acc_xai", "xai-api", { provider: "xai", billing: { mode: "metered" } }),
    account("acc_proxy", "local-proxy", { provider: "ai-proxy", billing: { mode: "free" } }),
    account("acc_ollama", "ollama-local", { provider: "ollama", billing: { mode: "free" } }),
    account("acc_off", "disabled-one", { enabled: false, provider: "groq" }),
    account("acc_grok", "grok", { provider: "grok-sub" }),
];

function writeConfig(config: Partial<AiConfigData>): void {
    const full: AiConfigData = {
        version: CONFIG_VERSION,
        accounts: ACCOUNTS,
        defaults: {},
        ...config,
    };

    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(join(home, ".genesis-tools", "ai", "config.json"), SafeJSON.stringify(full, null, 2));
    AiConfigStore.invalidate();
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-core-resolve-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    AiConfigStore.invalidate();
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    AiConfigStore.invalidate();
});

describe("resolveModel — explicit refs", () => {
    test("@account/<id>:<model> takes both halves from the ref", async () => {
        writeConfig({ defaults: { account: { chat: "@account/acc_max2" } } });

        const target = await resolveModelTarget("@account/acc_max:claude-opus-5");

        expect(target.account.id).toBe("acc_max");
        expect(target.model.id).toBe("claude-opus-5");
        expect(target.via).toContain("@account/acc_max:claude-opus-5");
    });

    test("@account/<id> with no model falls to the provider's catalog default", async () => {
        writeConfig({});

        const target = await resolveModelTarget("@account/acc_max");

        expect(target.account.id).toBe("acc_max");
        // anthropic-sub has no catalog rows of its own; the `-sub`-stripped key does.
        expect(target.model.provider).toBe("anthropic");
        expect(target.via).toContain("catalog default");
    });

    test("<provider>/<model> uses the task default account when it matches that provider", async () => {
        writeConfig({ defaults: { account: { chat: "@account/acc_max2" } } });

        const target = await resolveModelTarget("anthropic-sub/claude-sonnet-5");

        expect(target.account.id).toBe("acc_max2");
        expect(target.model.id).toBe("claude-sonnet-5");
    });

    test("<provider>/<model> falls to the first enabled account of that provider otherwise", async () => {
        writeConfig({ defaults: { account: { chat: "@account/acc_max" } } });

        const target = await resolveModelTarget("xai/grok-4.5");

        expect(target.account.id).toBe("acc_xai");
    });

    // `tools ask` lists a grok-sub account as "grok" and prints `-p grok`, so
    // this is the ref users are told to write. No plugin is called "grok".
    test("<provider>/<model> accepts the billing-mode-free provider name", async () => {
        writeConfig({});

        const target = await resolveModelTarget("grok/grok-4.5");

        expect(target.account.id).toBe("acc_grok");
        expect(target.account.provider).toBe("grok-sub");
    });

    test("the default account keeps its priority when matched by provider name", async () => {
        writeConfig({
            accounts: [...ACCOUNTS, account("acc_grok2", "grok-second", { provider: "grok-sub" })],
            defaults: { account: { chat: "@account/acc_grok2" } },
        });

        const target = await resolveModelTarget("grok/grok-4.5");

        expect(target.account.id).toBe("acc_grok2");
    });

    test("an exact plugin id still beats the billing-mode-free name", async () => {
        writeConfig({
            accounts: [...ACCOUNTS, account("acc_anthropic_key", "anthropic-api", { provider: "anthropic" })],
        });

        const target = await resolveModelTarget("anthropic/claude-sonnet-5");

        expect(target.account.id).toBe("acc_anthropic_key");
    });

    test("a bare model id uses the default account", async () => {
        writeConfig({ defaults: { account: { chat: "@account/acc_max2" } } });

        const target = await resolveModelTarget("claude-opus-5");

        expect(target.account.id).toBe("acc_max2");
        expect(target.model.id).toBe("claude-opus-5");
    });

    test("@proxy/<slug>/<model> binds the ai-proxy account and keeps the gateway's own id shape", async () => {
        writeConfig({});

        const target = await resolveModelTarget("@proxy/grok/grok-4.5");

        expect(target.account.id).toBe("acc_proxy");
        expect(target.plugin.id).toBe("ai-proxy");
        expect(target.model.id).toBe("grok/grok-4.5");
    });

    test("an alias resolves and is named in `via`", async () => {
        writeConfig({
            defaults: { account: { chat: "@account/acc_max" } },
            models: { aliases: { fast: "claude-haiku-4-5-20251001" } },
        });

        const target = await resolveModelTarget("fast");

        expect(target.model.id).toBe("claude-haiku-4-5-20251001");
        expect(target.via).toContain('alias "fast"');
    });
});

describe("resolveModel — defaults ladder", () => {
    test("defaults.app beats defaults.task", async () => {
        writeConfig({
            defaults: {
                account: { chat: "@account/acc_max" },
                task: { summarize: { model: "claude-sonnet-5" } },
                app: { youtube: { summarize: { model: "claude-opus-5" } } },
            },
        });

        const target = await resolveModelTarget(undefined, { task: "summarize", app: "youtube" });

        expect(target.model.id).toBe("claude-opus-5");
        expect(target.via).toBe("defaults.app.youtube.summarize");
    });

    test("defaults.app for a DIFFERENT app does not apply", async () => {
        writeConfig({
            defaults: {
                account: { chat: "@account/acc_max" },
                task: { summarize: { model: "claude-sonnet-5" } },
                app: { youtube: { summarize: { model: "claude-opus-5" } } },
            },
        });

        const target = await resolveModelTarget(undefined, { task: "summarize", app: "claude" });

        expect(target.model.id).toBe("claude-sonnet-5");
        expect(target.via).toBe("defaults.task.summarize");
    });

    test("defaults.task beats the account default's catalog model", async () => {
        writeConfig({
            defaults: {
                account: { chat: "@account/acc_max" },
                task: { chat: { model: "claude-sonnet-4-5-20250929" } },
            },
        });

        const target = await resolveModelTarget(undefined);

        expect(target.model.id).toBe("claude-sonnet-4-5-20250929");
    });

    test("defaults.account[task] beats defaults.account.chat", async () => {
        writeConfig({
            defaults: { account: { chat: "@account/acc_max", summarize: "@account/acc_max2" } },
        });

        const target = await resolveModelTarget(undefined, { task: "summarize" });

        expect(target.account.id).toBe("acc_max2");
    });

    test("defaults.account.chat is the global fallback for any task", async () => {
        writeConfig({ defaults: { account: { chat: "@account/acc_max" } } });

        const target = await resolveModelTarget(undefined, { task: "translate" });

        expect(target.account.id).toBe("acc_max");
    });

    test("a task default may itself be a full account ref", async () => {
        writeConfig({
            defaults: {
                account: { chat: "@account/acc_max" },
                task: { chat: { model: "@account/acc_max2:claude-sonnet-5" } },
            },
        });

        const target = await resolveModelTarget(undefined);

        expect(target.account.id).toBe("acc_max2");
        expect(target.model.id).toBe("claude-sonnet-5");
    });

    test("a rung's `provider` fills only the half the model ref left open", async () => {
        writeConfig({
            defaults: {
                account: { chat: "@account/acc_max" },
                task: { chat: { provider: "xai", model: "@account/acc_max2:claude-sonnet-5" } },
            },
        });

        const target = await resolveModelTarget(undefined);

        expect(target.account.id).toBe("acc_max2");
    });
});

describe("resolveModel — an explicit ref never mixes with a configured spec", () => {
    test("defaults.task is skipped entirely when a ref names only the account", async () => {
        writeConfig({
            defaults: {
                account: { chat: "@account/acc_max" },
                task: { chat: { model: "claude-sonnet-5" } },
            },
        });

        const target = await resolveModelTarget("@account/acc_max2");

        // Not claude-sonnet-5: blending the configured spec into an explicit ref
        // is what `fallbackSpec` forbids.
        expect(target.model.id).not.toBe("claude-sonnet-5");
        expect(target.via).toContain("catalog default");
    });

    test("defaults.app is skipped entirely when a ref names only the model", async () => {
        writeConfig({
            defaults: {
                account: { chat: "@account/acc_max" },
                app: { youtube: { chat: { model: "@account/acc_xai:grok-4.5" } } },
            },
        });

        const target = await resolveModelTarget("claude-opus-5", { app: "youtube" });

        expect(target.account.id).toBe("acc_max");
        expect(target.model.id).toBe("claude-opus-5");
    });
});

describe("resolveModel — unlisted models", () => {
    test("a model the catalog does not know still resolves, flagged unlisted", async () => {
        writeConfig({ defaults: { account: { chat: "@account/acc_max" } } });

        const target = await resolveModelTarget("claude-opus-9-unreleased");

        expect(isUnlisted(target.model)).toBe(true);
        expect(target.model.id).toBe("claude-opus-9-unreleased");
        expect(target.model.provider).toBe("anthropic-sub");
    });
});

describe("resolveModel — errors", () => {
    test("no defaults at all names `tools ai config default set`", async () => {
        writeConfig({});

        expect(resolveModelTarget(undefined)).rejects.toThrow(ModelResolutionError);
        expect(resolveModelTarget(undefined)).rejects.toThrow("tools ai config default set");
    });

    test("a missing account is reported with the rung that pointed at it", async () => {
        writeConfig({ defaults: { account: { chat: "@account/acc_ghost" } } });

        expect(resolveModelTarget(undefined)).rejects.toThrow("defaults.account.chat");
    });

    test("a disabled account is refused rather than silently skipped", async () => {
        writeConfig({});

        expect(resolveModelTarget("@account/acc_off:llama")).rejects.toThrow("disabled");
    });

    test("a provider with no enabled account names `account add`", async () => {
        writeConfig({ defaults: { account: { chat: "@account/acc_max" } } });

        expect(resolveModelTarget("groq/llama-3.3-70b")).rejects.toThrow("tools ai config account add --provider groq");
    });

    // `account add --provider nope` would die on the same unknown id, so the
    // error must not suggest it — it names the real plugin ids instead.
    test("a provider id no plugin owns lists the known providers", async () => {
        writeConfig({});

        expect(resolveModelTarget("nope/some-model")).rejects.toThrow(/No provider plugin is called "nope".*grok-sub/);
    });

    test("a provider that cannot chat fails resolution instead of throwing from language()", async () => {
        writeConfig({});

        // `ollama` declares embed/summarize/translate; its binding's language()
        // throws by design (local/adapters (language() throws by design)).
        expect(resolveModelTarget("@account/acc_ollama:nomic-embed")).rejects.toThrow("cannot chat");
    });

    test("a provider switched off in disabledProviders is refused", async () => {
        writeConfig({ disabledProviders: ["xai"], defaults: { account: { chat: "@account/acc_max" } } });

        expect(resolveModelTarget("@account/acc_xai:grok-4.5")).rejects.toThrow("switched off");
    });

    test("a malformed ref surfaces the grammar", async () => {
        writeConfig({ defaults: { account: { chat: "@account/acc_max" } } });

        expect(resolveModelTarget("@proxy/onlyslug")).rejects.toThrow("@proxy/<slug>/<modelId>");
    });
});

describe("auto account", () => {
    const usage = (accountId: string, limits: AccountUsageSnapshot["limits"]): AccountUsageSnapshot => ({
        provider: "anthropic-sub",
        accountId,
        accountName: accountId,
        fetchedAt: "2026-10-19T12:00:00Z",
        limits,
    });
    const refusal = (statusCode: number) =>
        new APICallError({
            message: `status ${statusCode}`,
            url: "https://api.example.test",
            requestBodyValues: {},
            statusCode,
        });

    test("ranks subscription accounts by the room left in windows that apply, full ones last, paid ones never", async () => {
        writeConfig({});
        const candidates = await autoAccountCandidates({
            snapshots: [
                usage("acc_max", [{ key: "five_hour", label: "5h", kind: "session", percentUsed: 100 }]),
                usage("acc_max2", [
                    { key: "five_hour", label: "5h", kind: "session", percentUsed: 30 },
                    // A Sonnet-only window says nothing about the Opus default, and credit is money, not room.
                    {
                        key: "seven_day_sonnet",
                        label: "7d Sonnet",
                        kind: "scoped",
                        scopeModel: "sonnet",
                        percentUsed: 99,
                    },
                    { key: "extra", label: "Extra", kind: "credit", percentUsed: 100 },
                ]),
            ],
        });
        const ids = candidates.map((candidate) => candidate.target.account.id);

        expect(ids).not.toContain("acc_xai");
        expect(ids.indexOf("acc_max2")).toBeLessThan(ids.indexOf("acc_max"));
        expect(ids.at(-1)).toBe("acc_max");
        expect(candidates.find((c) => c.target.account.id === "acc_max2")?.why).toBe("5h 30% used");
        expect(candidates.find((c) => c.target.account.id === "acc_max")?.why).toBe("5h 100% used (full)");
    });

    test("prefers Claude, then Codex, then Grok while each keeps over 10% weekly room", async () => {
        const sub = (id: string, provider: string) => account(id, id, { provider });
        writeConfig({
            accounts: [
                sub("acc_grok", "grok-sub"),
                sub("acc_codex", "openai-sub"),
                sub("acc_claude_low", "anthropic-sub"),
                sub("acc_claude_busy", "anthropic-sub"),
                sub("acc_claude_idle", "anthropic-sub"),
                sub("acc_claude_unknown", "anthropic-sub"),
            ],
        });
        const weekly = (id: string, provider: string, percentUsed: number): AccountUsageSnapshot => ({
            ...usage(id, [{ key: "seven_day", label: "Weekly", kind: "weekly", percentUsed }]),
            provider,
        });
        const ranked = await autoAccountCandidates({
            snapshots: [
                weekly("acc_grok", "grok-sub", 0),
                weekly("acc_codex", "openai-sub", 5),
                weekly("acc_claude_low", "anthropic-sub", 90),
                weekly("acc_claude_busy", "anthropic-sub", 70),
                weekly("acc_claude_idle", "anthropic-sub", 20),
            ],
        });

        expect(ranked.map((c) => c.target.account.id)).toEqual([
            "acc_claude_idle",
            "acc_claude_busy",
            "acc_codex",
            "acc_grok",
            "acc_claude_unknown",
            "acc_claude_low",
        ]);
        expect(ranked.at(-1)?.why).toBe("Weekly 90% used (10% weekly room or less)");
    });

    test("isAccountRefusal: 401, 403 and 429, also wrapped in SDK retries; never a server error", () => {
        expect(isAccountRefusal(refusal(429))).toBe(true);
        expect(isAccountRefusal(refusal(403))).toBe(true);
        expect(
            isAccountRefusal(new RetryError({ message: "x", reason: "maxRetriesExceeded", errors: [refusal(429)] }))
        ).toBe(true);
        expect(isAccountRefusal(refusal(500))).toBe(false);
        expect(isAccountRefusal(new Error("boom"))).toBe(false);
    });

    async function fakeCandidates(): Promise<{ candidates: AutoCandidate[]; disposed: string[] }> {
        writeConfig({});
        const disposed: string[] = [];
        const candidates = await Promise.all(
            ["acc_max", "acc_max2"].map(async (id) => {
                const target = await resolveModelTarget(`@account/${id}`);
                const binding: ProviderBinding = {
                    accountId: id,
                    providerId: target.account.provider,
                    billed: false,
                    language: () => {
                        throw new Error("not called");
                    },
                    dispose: () => {
                        disposed.push(id);
                    },
                };
                return { target: { ...target, plugin: { ...target.plugin, bind: async () => binding } }, why: "x" };
            })
        );
        return { candidates, disposed };
    }

    test("runWithAutoAccount moves to the next account when one refuses, and disposes each binding", async () => {
        const { candidates, disposed } = await fakeCandidates();
        const asked: string[] = [];
        const result = await runWithAutoAccount({
            candidates,
            app: "test",
            run: async (resolved) => {
                asked.push(resolved.account.id);
                if (resolved.account.id === "acc_max") {
                    throw new RetryError({ message: "x", reason: "maxRetriesExceeded", errors: [refusal(429)] });
                }

                return "ok";
            },
        });

        expect(result).toBe("ok");
        expect(asked).toEqual(["acc_max", "acc_max2"]);
        expect(disposed).toEqual(["acc_max", "acc_max2"]);
    });

    test("runWithAutoAccount rethrows an error another account would not fix, without trying the next", async () => {
        const { candidates } = await fakeCandidates();
        const asked: string[] = [];
        const outcome = await runWithAutoAccount({
            candidates,
            app: "test",
            run: async (resolved) => {
                asked.push(resolved.account.id);
                throw refusal(500);
            },
        }).catch((error: unknown) => error);

        expect(APICallError.isInstance(outcome) && outcome.statusCode).toBe(500);
        expect(asked).toEqual(["acc_max"]);
    });
});
