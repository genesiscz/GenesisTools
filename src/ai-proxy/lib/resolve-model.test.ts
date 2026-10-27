import { describe, expect, it } from "bun:test";
import { resolveProxyRoute } from "@app/ai-proxy/lib/account-model-ref";
import { sessionRouteDenial } from "@app/ai-proxy/lib/clients";
import { parseProxyModelId, resolveModel } from "@app/ai-proxy/lib/resolve-model";
import { sessionPickerModels } from "@app/ai-proxy/lib/sessions/picker-models";
import { type AiProxySessionRecord, sessionProxyAccounts } from "@app/ai-proxy/lib/sessions/records";
import { resolveSessionRoute, sessionPinnedRoute } from "@app/ai-proxy/lib/sessions/routing";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { mergeCodexModelRecords } from "@genesiscz/utils/ai/openai/codex-models";
import { SafeJSON } from "@genesiscz/utils/json";

function grokAccount(name: string): AiProxyAccountConfig {
    return { name, provider: "grok-subscription", providerSlug: "grok", enabled: true };
}

describe("resolve-model", () => {
    it("parses three-segment proxy ids", () => {
        expect(parseProxyModelId("genesiscz/grok/grok-build")).toEqual({
            accountName: "genesiscz",
            providerSlug: "grok",
            upstreamId: "grok-build",
        });
    });

    it("preserves slashes in upstream model id", () => {
        expect(parseProxyModelId("genesiscz/grok/grok-build/extra").upstreamId).toBe("grok-build/extra");
    });

    it("rejects bare upstream ids in parseProxyModelId", () => {
        expect(() => parseProxyModelId("grok-build")).toThrow("must be <account>/<provider>/<model>");
    });

    it("rejects unknown bare ids when no account matches", () => {
        expect(() => resolveModel("composer-2.5", [])).toThrow("No enabled account for model");
        expect(() => resolveModel("composer-2.5[fast=false]", [])).toThrow("No enabled account for model");
    });

    it("resolves bare upstream ids", () => {
        const accounts = [grokAccount("martin")];

        const route = resolveModel("grok-build-0.1", accounts);

        expect(route.accountName).toBe("martin");
        expect(route.providerSlug).toBe("grok");
        expect(route.upstreamId).toBe("grok-build-0.1");
    });

    it("resolves provider/upstream shorthand ids", () => {
        const accounts = [grokAccount("martin")];

        const route = resolveModel("grok/grok-build-0.1", accounts);

        expect(route.accountName).toBe("martin");
        expect(route.providerSlug).toBe("grok");
        expect(route.upstreamId).toBe("grok-build-0.1");
    });

    it("rejects bare upstream ids as ambiguous when grok + xai accounts are both implemented", () => {
        const accounts: AiProxyAccountConfig[] = [
            grokAccount("martin"),
            { name: "work", provider: "xai-api-key", providerSlug: "xai", enabled: true },
        ];

        expect(() => resolveModel("grok-build-0.1", accounts)).toThrow("Ambiguous model");
    });

    it("resolves provider/upstream to the xai account when slug is unique", () => {
        const accounts: AiProxyAccountConfig[] = [
            grokAccount("martin"),
            { name: "work", provider: "xai-api-key", providerSlug: "xai", enabled: true },
        ];

        const route = resolveModel("xai/grok-4.5", accounts);

        expect(route.accountName).toBe("work");
        expect(route.providerSlug).toBe("xai");
        expect(route.upstreamId).toBe("grok-4.5");
    });

    it("rejects ambiguous bare upstream ids across multiple implemented grok accounts", () => {
        const accounts = [grokAccount("martin"), grokAccount("work")];

        expect(() => resolveModel("grok-build-0.1", accounts)).toThrow("Ambiguous model");
    });

    it("strips a trailing :<effort> suffix and returns reasoningEffort", () => {
        const accounts = [grokAccount("martin")];

        const route = resolveModel("martin/grok/grok-4.6:xhigh", accounts);

        expect(route.upstreamId).toBe("grok-4.6");
        expect(route.reasoningEffort).toBe("xhigh");
        expect(route.accountName).toBe("martin");
    });

    it("leaves OpenRouter :batch suffixes on the upstream id", () => {
        const accounts: AiProxyAccountConfig[] = [
            { name: "openrouter", provider: "openrouter", providerSlug: "openrouter", enabled: true },
        ];

        const route = resolveModel("openrouter/openrouter/anthropic/claude-opus-4.6:batch", accounts);

        expect(route.upstreamId).toBe("anthropic/claude-opus-4.6:batch");
        expect(route.reasoningEffort).toBeUndefined();
    });

    it("rejects ambiguous provider/upstream ids across multiple accounts", () => {
        const accounts = [grokAccount("martin"), grokAccount("work")];

        expect(() => resolveModel("grok/grok-build-0.1", accounts)).toThrow("Ambiguous model");
    });

    it("rejects empty model-id segments", () => {
        expect(() => parseProxyModelId("genesiscz/grok/")).toThrow("must be <account>/<provider>/<model>");
        expect(() => parseProxyModelId("/grok/model")).toThrow("must be <account>/<provider>/<model>");
    });

    it("resolves account by name and provider slug", () => {
        const route = resolveModel("genesiscz/grok/grok-build", [grokAccount("genesiscz")]);

        expect(route.account.provider).toBe("grok-subscription");
        expect(route.upstreamId).toBe("grok-build");
    });
});

/**
 * OpenRouter ids contain a slash, which collides head-on with this module's
 * `<account>/<provider>/<model>` grammar. These cases pin BOTH directions: what
 * newly resolves, and what must keep throwing.
 */
describe("resolve-model with openrouter accounts", () => {
    const openRouterAccount = (name: string): AiProxyAccountConfig => ({
        name,
        provider: "openrouter",
        providerSlug: "openrouter",
        enabled: true,
    });

    it("resolves the fully qualified four-segment id", () => {
        const route = resolveModel("default/openrouter/anthropic/claude-sonnet-5", [openRouterAccount("default")]);

        expect(route.accountName).toBe("default");
        expect(route.providerSlug).toBe("openrouter");
        expect(route.upstreamId).toBe("anthropic/claude-sonnet-5");
    });

    /**
     * This is the shape `core/model-ref.ts` produces for
     * `@proxy/<slug>/openrouter/anthropic/...`: the account name is missing, so
     * `parseProxyModelId` reads "openrouter" as the account and "anthropic" as the
     * provider. Without the retry the utils-to-proxy path is broken end to end.
     */
    it("resolves the provider-slug shorthand the @proxy path produces", () => {
        const route = resolveModel("openrouter/anthropic/claude-sonnet-5", [openRouterAccount("default")]);

        expect(route.accountName).toBe("default");
        expect(route.providerSlug).toBe("openrouter");
        expect(route.upstreamId).toBe("anthropic/claude-sonnet-5");
    });

    it("resolves a bare openrouter id, slash preserved", () => {
        const route = resolveModel("anthropic/claude-sonnet-5", [openRouterAccount("default")]);

        expect(route.accountName).toBe("default");
        expect(route.upstreamId).toBe("anthropic/claude-sonnet-5");
    });

    /** The provider-slug reading is tried first, so it still wins where it applies. */
    it("prefers an account whose providerSlug is literally the vendor prefix", () => {
        const accounts: AiProxyAccountConfig[] = [
            openRouterAccount("router"),
            { name: "direct", provider: "anthropic-subscription", providerSlug: "anthropic", enabled: true },
        ];

        const route = resolveModel("anthropic/claude-sonnet-5", accounts);

        expect(route.accountName).toBe("direct");
        expect(route.providerSlug).toBe("anthropic");
        expect(route.upstreamId).toBe("claude-sonnet-5");
    });

    it("reports two openrouter accounts as ambiguous rather than guessing", () => {
        const accounts = [openRouterAccount("personal"), openRouterAccount("work")];

        expect(() => resolveModel("anthropic/claude-sonnet-5", accounts)).toThrow("Ambiguous model");
    });

    /**
     * 🛑 The gate. Ungated, this would stop throwing a clear local error and become
     * an upstream 404 charged through a BILLED account. OpenRouter serves
     * `x-ai/grok-4.5`, never `xai/grok-4.5`, so the catalog says no.
     */
    it("still throws for a slashed id openrouter does not serve", () => {
        expect(() => resolveModel("xai/grok-4.5", [openRouterAccount("default")])).toThrow(
            "No enabled account for model"
        );
    });

    it("still throws when no openrouter account exists at all", () => {
        expect(() => resolveModel("anthropic/claude-sonnet-5", [grokAccount("martin")])).toThrow(
            "No enabled account for model"
        );
    });
});

describe("resolveSessionRoute", () => {
    const accounts: AiProxyAccountConfig[] = [
        { name: "work-codex", provider: "openai-subscription", providerSlug: "codex", enabled: true },
        { name: "side-codex", provider: "openai-subscription", providerSlug: "codex", enabled: true },
        { name: "work-claude", provider: "anthropic-subscription", providerSlug: "claude-sub", enabled: true },
        { name: "work-grok", provider: "grok-subscription", providerSlug: "grok", enabled: true },
        { name: "off-claude", provider: "anthropic-subscription", providerSlug: "claude-sub", enabled: false },
    ];

    function record(overrides: Partial<AiProxySessionRecord> = {}): AiProxySessionRecord {
        return {
            version: 1,
            id: "0f8a495a-0000-4000-8000-000000000001",
            keyHash: "0".repeat(64),
            createdAt: "2026-10-25T20:00:00.000Z",
            codexProxyAccount: "side-codex",
            claudeProxyAccount: "work-claude",
            moves: [],
            meteredConfirmed: [],
            ...overrides,
        };
    }

    function routeOf(model: string, session = record()) {
        const result = resolveSessionRoute(model, session, accounts);

        if (!result || "refusal" in result) {
            throw new Error(`expected a route for ${model}, got ${SafeJSON.stringify(result)}`);
        }

        return result.route;
    }

    it("routes codex/<id> to the record's Codex account, even with two Codex accounts enabled", () => {
        const route = routeOf("codex/gpt-6.1-sol");

        expect(route.accountName).toBe("side-codex");
        expect(route.upstreamId).toBe("gpt-6.1-sol");
        expect(route.reasoningEffort).toBeUndefined();
        expect(route.effortSource).toBeUndefined();
    });

    it("routes the /model picker's codex-claude/<id> like codex/<id>, and lists the picker ids Claude Code keeps", () => {
        const route = routeOf("codex-claude/gpt-6.1-sol");

        expect(route.accountName).toBe("side-codex");
        expect(route.upstreamId).toBe("gpt-6.1-sol");

        const listed = mergeCodexModelRecords({ cache: [] });
        const picker = sessionPickerModels([...listed.values()].filter((model) => model.visibility === "list"));

        expect(picker.data.length).toBeGreaterThan(0);
        // Claude Code 2.1.310 drops a gateway model whose id names neither claude nor anthropic.
        expect(picker.data.every((model) => /(claude|anthropic)/i.test(model.id))).toBe(true);
        // Claude Code takes CLAUDE_CODE_MAX_CONTEXT_TOKENS only for an id that does not start with claude-.
        expect(picker.data.some((model) => /^claude-/i.test(model.id))).toBe(false);
        expect(picker.data.map((model) => model.id)).toContain("codex-claude/gpt-6.1-sol");
        expect(picker.data.every((model) => routeOf(model.id).accountName === "side-codex")).toBe(true);
    });

    it("pins every session route to its account, short form or full id, so a session never reaches a failover login", async () => {
        const pooled: AiProxyAccountConfig = {
            name: "pooled-codex",
            provider: "openai-subscription",
            providerSlug: "codex",
            enabled: true,
            failover: true,
            openaiSub: { accountName: "work", failoverAccountNames: ["side"] },
        };
        const all = [...accounts, pooled];
        const short = resolveSessionRoute("codex/gpt-6.1-sol", record({ codexProxyAccount: "pooled-codex" }), all);

        if (!short || "refusal" in short) {
            throw new Error(`expected a route, got ${SafeJSON.stringify(short)}`);
        }

        // The full id goes through the normal resolver, which returns the configured account as it is.
        const full = await resolveProxyRoute("pooled-codex/codex/gpt-6.1-sol", all);
        expect(full.account.failover).toBe(true);

        for (const route of [short.route, full]) {
            const pinned = sessionPinnedRoute(route);
            expect(pinned.account.failover).toBe(false);
            expect(pinned.providerKeySuffix).toBe("#session");
        }

        expect(pooled.failover).toBe(true);
        expect(sessionPinnedRoute(routeOf("codex/gpt-6.1-sol")).providerKeySuffix).toBeUndefined();
    });

    it("keeps an :effort suffix and marks it as the effort's source", () => {
        const route = routeOf("codex/gpt-6-astra:xhigh");

        expect(route.upstreamId).toBe("gpt-6-astra");
        expect(route.reasoningEffort).toBe("xhigh");
        expect(route.effortSource).toBe("suffix");
    });

    it("routes a bare claude-* id, with or without [1m], to the record's Claude account", () => {
        expect(routeOf("claude-opus-5-5").accountName).toBe("work-claude");

        const oneM = routeOf("claude-opus-5-5[1m]");
        expect(oneM.accountName).toBe("work-claude");
        expect(oneM.upstreamId).toBe("claude-opus-5-5");
    });

    it("routes grok/<id> only when the record has a Grok account", () => {
        expect(routeOf("grok/grok-4.6", record({ grokProxyAccount: "work-grok" })).accountName).toBe("work-grok");
        expect(resolveSessionRoute("grok/grok-4.6", record(), accounts)).toEqual({
            refusal:
                "session 0f8a495a-0000-4000-8000-000000000001 has no grok account, so it cannot run 'grok/grok-4.6'",
        });
    });

    it("refuses a Claude id in a session without a Claude account, and a disabled or wrong-kind account", () => {
        const noClaude = resolveSessionRoute("claude-haiku-5-5", record({ claudeProxyAccount: undefined }), accounts);
        expect(noClaude && "refusal" in noClaude ? noClaude.refusal : "").toContain("has no claude account");

        const disabled = resolveSessionRoute(
            "claude-haiku-5-5",
            record({ claudeProxyAccount: "off-claude" }),
            accounts
        );
        expect(disabled && "refusal" in disabled ? disabled.refusal : "").toContain("is disabled");

        const wrongKind = resolveSessionRoute(
            "codex/gpt-6-luna",
            record({ codexProxyAccount: "work-claude" }),
            accounts
        );
        expect(wrongKind && "refusal" in wrongKind ? wrongKind.refusal : "").toContain(
            "is a anthropic-subscription account"
        );
    });

    it("leaves full account/provider/model ids, @account refs and other bare ids to the normal resolver", () => {
        for (const model of [
            "work-codex/codex/gpt-6.1-sol:high",
            "@account/abc:gpt-6.1-sol",
            "grok-4.6",
            "openai/gpt-6",
        ]) {
            expect(resolveSessionRoute(model, record(), accounts)).toBeUndefined();
        }
    });

    it("builds an account in memory for a login the record names (DECISION 1 a), and lets the session use it", () => {
        const session = record({
            codexProxyAccount: undefined,
            codexAccount: "work",
            claudeProxyAccount: undefined,
            claudeAccount: "personal",
        });
        const codex = routeOf("codex/gpt-6.1-sol", session);
        const claude = routeOf("claude-opus-5-5", session);

        expect(codex.account).toEqual({
            name: "login:work",
            provider: "openai-subscription",
            providerSlug: "codex",
            enabled: true,
            openaiSub: { accountName: "work" },
        });
        expect(claude.account).toMatchObject({ name: "login:personal", anthropicSub: { accountName: "personal" } });
        expect(sessionRouteDenial(session, codex.account)).toBeNull();
        expect(sessionProxyAccounts(session)).toEqual(["login:work", "login:personal"]);
    });

    it("prefers the configured proxy account the record names over its login (the legacy auth.json account keeps working)", () => {
        const route = routeOf("codex/gpt-6.1-sol", record({ codexProxyAccount: "side-codex", codexAccount: "work" }));

        expect(route.accountName).toBe("side-codex");
    });

    it("marks an effort suffix on the normal resolver too", () => {
        const route = resolveModel("work-grok/grok/grok-4.6:high", accounts);

        expect(route.reasoningEffort).toBe("high");
        expect(route.effortSource).toBe("suffix");
    });
});
