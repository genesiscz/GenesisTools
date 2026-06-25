import { describe, expect, it } from "bun:test";
import { parseProxyModelId, resolveModel } from "@app/ai-proxy/lib/resolve-model";

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

    it("rejects bare upstream ids", () => {
        expect(() => parseProxyModelId("grok-build")).toThrow("must be <account>/<provider>/<model>");
    });

    it("rejects empty model-id segments", () => {
        expect(() => parseProxyModelId("genesiscz/grok/")).toThrow("must be <account>/<provider>/<model>");
        expect(() => parseProxyModelId("/grok/model")).toThrow("must be <account>/<provider>/<model>");
    });

    it("resolves account by name and provider slug", () => {
        const route = resolveModel("genesiscz/grok/grok-build", [
            {
                name: "genesiscz",
                provider: "grok-subscription",
                providerSlug: "grok",
                enabled: true,
            },
        ]);

        expect(route.account.provider).toBe("grok-subscription");
        expect(route.upstreamId).toBe("grok-build");
    });
});
