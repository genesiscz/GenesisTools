import { describe, expect, test } from "bun:test";
import { type AiConfigData, emptyConfig } from "../config/schema";
import { formatModelRef, ModelRefError, parseModelRef } from "./model-ref";

function configWithAliases(aliases: Record<string, string>): AiConfigData {
    return { ...emptyConfig(), models: { aliases } };
}

const plain = emptyConfig();

describe("parseModelRef — grammar", () => {
    test("a bare id is bare", () => {
        expect(parseModelRef("opus", plain)).toEqual({ kind: "bare", modelId: "opus" });
    });

    test("provider/model splits on the first slash", () => {
        expect(parseModelRef("anthropic/claude-opus-4-5", plain)).toEqual({
            kind: "provider",
            providerId: "anthropic",
            modelId: "claude-opus-4-5",
        });
    });

    test("a model id containing slashes survives as the model half", () => {
        expect(parseModelRef("openrouter/anthropic/claude-3.5-sonnet", plain)).toEqual({
            kind: "provider",
            providerId: "openrouter",
            modelId: "anthropic/claude-3.5-sonnet",
        });
    });

    test("@account/<id> carries no model", () => {
        expect(parseModelRef("@account/acc_work", plain)).toEqual({ kind: "account", accountId: "acc_work" });
    });

    test("@account/<id>:<model> carries both", () => {
        expect(parseModelRef("@account/acc_work:opus", plain)).toEqual({
            kind: "account",
            accountId: "acc_work",
            modelId: "opus",
        });
    });

    test("@proxy/<slug>/<model>", () => {
        expect(parseModelRef("@proxy/grok/grok-4.5", plain)).toEqual({
            kind: "proxy",
            slug: "grok",
            modelId: "grok-4.5",
        });
    });

    test("a proxy model id may itself contain slashes", () => {
        expect(parseModelRef("@proxy/router/anthropic/claude-3.5", plain)).toEqual({
            kind: "proxy",
            slug: "router",
            modelId: "anthropic/claude-3.5",
        });
    });

    test("surrounding whitespace is trimmed", () => {
        expect(parseModelRef("  opus  ", plain)).toEqual({ kind: "bare", modelId: "opus" });
    });
});

describe("parseModelRef — aliases", () => {
    test("an alias expands before parsing and is recorded", () => {
        const cfg = configWithAliases({ fast: "groq/llama-3.3-70b" });

        expect(parseModelRef("fast", cfg)).toEqual({
            kind: "provider",
            providerId: "groq",
            modelId: "llama-3.3-70b",
            alias: "fast",
        });
    });

    test("expansion is one level only — a chained alias is used verbatim", () => {
        const cfg = configWithAliases({ a: "b", b: "groq/llama-3.3-70b" });

        expect(parseModelRef("a", cfg)).toEqual({ kind: "bare", modelId: "b", alias: "a" });
    });

    test("an alias that collides with a provider id wins over the provider reading", () => {
        const cfg = configWithAliases({ anthropic: "@account/acc_work:opus" });

        expect(parseModelRef("anthropic", cfg)).toEqual({
            kind: "account",
            accountId: "acc_work",
            modelId: "opus",
            alias: "anthropic",
        });
    });

    test("an alias only matches the whole ref, not its provider half", () => {
        const cfg = configWithAliases({ anthropic: "@account/acc_work:opus" });

        expect(parseModelRef("anthropic/claude-opus-4-5", cfg)).toEqual({
            kind: "provider",
            providerId: "anthropic",
            modelId: "claude-opus-4-5",
        });
    });

    test("an empty alias expansion is ignored", () => {
        const cfg = configWithAliases({ fast: "   " });

        expect(parseModelRef("fast", cfg)).toEqual({ kind: "bare", modelId: "fast" });
    });
});

describe("parseModelRef — malformed", () => {
    const cases: Array<[string, string]> = [
        ["", "the ref is empty"],
        ["   ", "the ref is empty"],
        ["@account/", "the account id after @account/ is empty"],
        ["@account/acc_work:", "the model id after the colon is empty"],
        ["@proxy/grok", "a proxy ref needs both a slug and a model id"],
        ["@proxy/", "a proxy ref needs both a slug and a model id"],
        ["@proxy//grok-4.5", "the proxy slug is empty"],
        ["@proxy/grok/", "the model id after the proxy slug is empty"],
        ["@bogus/thing", "is not a known ref namespace"],
        ["/claude-opus-4-5", "the provider id before the slash is empty"],
        ["anthropic/", "the model id after the slash is empty"],
    ];

    for (const [ref, problem] of cases) {
        test(`"${ref}" is rejected: ${problem}`, () => {
            expect(() => parseModelRef(ref, plain)).toThrow(ModelRefError);
            expect(() => parseModelRef(ref, plain)).toThrow(problem);
        });
    }

    test("the error message shows the grammar", () => {
        expect(() => parseModelRef("@account/", plain)).toThrow("@proxy/<slug>/<modelId>");
    });

    test("a malformed ALIAS EXPANSION reports the alias the user wrote", () => {
        const cfg = configWithAliases({ fast: "@account/" });

        expect(() => parseModelRef("fast", cfg)).toThrow('Malformed model ref "fast"');
    });
});

describe("formatModelRef", () => {
    const refs = [
        "opus",
        "anthropic/claude-opus-4-5",
        "@account/acc_work",
        "@account/acc_work:opus",
        "@proxy/grok/grok-4.5",
    ];

    for (const ref of refs) {
        test(`round-trips ${ref}`, () => {
            expect(formatModelRef(parseModelRef(ref, plain))).toBe(ref);
        });
    }
});
