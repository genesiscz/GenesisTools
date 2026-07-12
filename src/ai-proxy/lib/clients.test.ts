import { describe, expect, it } from "bun:test";
import { OWNER_CLIENT_NAME, SUBSCRIPTION_PROVIDER_TYPES, validateClients } from "@app/ai-proxy/lib/clients";
import type { AiProxyClientConfig } from "@app/ai-proxy/lib/types";

const good: AiProxyClientConfig = { name: "alice", key: "k".repeat(24) };

describe("validateClients", () => {
    it("accepts a valid list and an absent list", () => {
        expect(validateClients(undefined)).toEqual([]);
        expect(validateClients([good])).toEqual([]);
    });

    it("rejects short keys, duplicate names, duplicate keys, and reserved owner name", () => {
        const problems = validateClients([
            { name: "alice", key: "short" },
            { name: "alice", key: "x".repeat(24) },
            { name: OWNER_CLIENT_NAME, key: "y".repeat(24) },
            { name: "bob", key: "x".repeat(24) },
        ]);
        expect(problems.some((p) => p.includes("at least 16"))).toBe(true);
        expect(problems.some((p) => p.includes("duplicate client name"))).toBe(true);
        expect(problems.some((p) => p.includes("duplicate client key"))).toBe(true);
        expect(problems.some((p) => p.includes("reserved"))).toBe(true);
    });

    it("rejects allowedProviders containing a subscription type", () => {
        const problems = validateClients([{ ...good, allowedProviders: ["anthropic-subscription"] }]);
        expect(problems.some((p) => p.includes("subscription providers cannot be granted"))).toBe(true);
        expect(SUBSCRIPTION_PROVIDER_TYPES.has("anthropic-subscription")).toBe(true);
    });
});
