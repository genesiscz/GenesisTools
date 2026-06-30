import { describe, expect, it } from "bun:test";
import { parseProxyModelId, resolveModel } from "@app/ai-proxy/lib/resolve-model";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";

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

    it("resolves bare upstream ids when another enabled account uses an unimplemented provider", () => {
        const accounts: AiProxyAccountConfig[] = [
            grokAccount("martin"),
            { name: "work", provider: "xai-api-key", providerSlug: "xai", enabled: true },
        ];

        const route = resolveModel("grok-build-0.1", accounts);

        expect(route.accountName).toBe("martin");
    });

    it("rejects ambiguous bare upstream ids across multiple implemented grok accounts", () => {
        const accounts = [grokAccount("martin"), grokAccount("work")];

        expect(() => resolveModel("grok-build-0.1", accounts)).toThrow("Ambiguous model");
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
