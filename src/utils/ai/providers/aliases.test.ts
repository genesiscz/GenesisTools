import { describe, expect, test } from "bun:test";
import {
    ACCOUNT_PROVIDER_ALIASES,
    isAccountProviderAlias,
    PROVIDER_ALIASES,
    providerAliasOf,
    resolveProviderAlias,
} from "./aliases";
import { UnknownProviderError } from "./registry";

describe("provider aliases", () => {
    test("every alias maps to a plugin id and back", () => {
        for (const alias of ACCOUNT_PROVIDER_ALIASES) {
            const id = PROVIDER_ALIASES[alias];

            expect(resolveProviderAlias(alias)).toBe(id);
            expect(resolveProviderAlias(id)).toBe(id);
            expect(providerAliasOf(id)).toBe(alias);
        }
    });

    test("aliases are case-insensitive and trimmed; ids are exact", () => {
        expect(resolveProviderAlias(" Codex ")).toBe("openai-sub");
        expect(() => resolveProviderAlias("OPENAI-SUB")).toThrow(UnknownProviderError);
    });

    test("an unknown provider throws the registry's error, so callers have one failure shape", () => {
        expect(() => resolveProviderAlias("gemini")).toThrow(UnknownProviderError);
    });

    test("a plugin id without an alias is returned as its own display alias", () => {
        expect(providerAliasOf("huggingface")).toBe("huggingface");
        expect(isAccountProviderAlias("grok")).toBe(true);
        expect(isAccountProviderAlias("huggingface")).toBe(false);
    });
});
