import { describe, expect, it } from "bun:test";
import {
    clientProviderDenial,
    OWNER_CLIENT_NAME,
    resolveClient,
    SUBSCRIPTION_PROVIDER_TYPES,
    validateClients,
} from "@app/ai-proxy/lib/clients";
import type { AiProxyClientConfig, AiProxyConfig } from "@app/ai-proxy/lib/types";

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

    it("reports malformed name/key/allowedProviders instead of throwing", () => {
        const malformed = { name: 123, key: true, allowedProviders: {} } as unknown as AiProxyClientConfig;
        const problems = validateClients([malformed]);
        expect(problems.some((p) => p.includes("must be a non-empty string of alphanumerics"))).toBe(true);
        expect(problems.some((p) => p.includes("key must be a string"))).toBe(true);
        expect(problems.some((p) => p.includes("allowedProviders must be an array"))).toBe(true);
    });

    it("reports a non-array clients config instead of throwing", () => {
        const malformed = { owner: true } as unknown as AiProxyClientConfig[];
        expect(validateClients(malformed)).toEqual(["clients config must be an array of client entries"]);
    });
});

function reqWithBearer(token: string | null): Request {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    return new Request("http://localhost/v1/chat/completions", { method: "POST", headers });
}

function cfg(clients?: AiProxyConfig["clients"]): AiProxyConfig {
    return { proxyApiKey: "owner-key-0123456789", clients } as AiProxyConfig;
}

describe("resolveClient", () => {
    it("resolves proxyApiKey to the owner identity", () => {
        const resolved = resolveClient(reqWithBearer("owner-key-0123456789"), cfg());
        expect(resolved).toEqual({ name: "owner", isOwner: true });
    });

    it("resolves a client key to its named identity", () => {
        const alice = { name: "alice", key: "alice-key-0123456789" };
        const resolved = resolveClient(reqWithBearer("alice-key-0123456789"), cfg([alice]));
        expect(resolved?.name).toBe("alice");
        expect(resolved?.isOwner).toBe(false);
        expect(resolved?.config).toEqual(alice);
    });

    it("rejects wrong keys, missing header, and disabled clients", () => {
        const disabled = { name: "mallory", key: "mallory-key-0123456", disabled: true };
        expect(resolveClient(reqWithBearer("nope-nope-nope-nope"), cfg([disabled]))).toBeNull();
        expect(resolveClient(reqWithBearer(null), cfg())).toBeNull();
        expect(resolveClient(reqWithBearer("mallory-key-0123456"), cfg([disabled]))).toBeNull();
    });

    it("skips a non-string client key and doesn't throw", () => {
        const malformed = { name: "mallory", key: 12345 } as unknown as NonNullable<AiProxyConfig["clients"]>[number];
        expect(resolveClient(reqWithBearer("owner-key-0123456789"), cfg([malformed]))).toEqual({
            name: "owner",
            isOwner: true,
        });
        expect(resolveClient(reqWithBearer("anything"), cfg([malformed]))).toBeNull();
    });

    it("treats a non-array clients config as empty instead of throwing", () => {
        const malformed = { owner: true } as unknown as AiProxyConfig["clients"];
        expect(resolveClient(reqWithBearer("owner-key-0123456789"), cfg(malformed))).toEqual({
            name: "owner",
            isOwner: true,
        });
    });
});

describe("clientProviderDenial", () => {
    const owner = { name: "owner", isOwner: true } as const;
    const alice = { name: "alice", isOwner: false, config: { name: "alice", key: "k".repeat(24) } };
    const bob = {
        name: "bob",
        isOwner: false,
        config: { name: "bob", key: "b".repeat(24), allowedProviders: ["xai-api-key" as const] },
    };

    it("owner may route anywhere", () => {
        expect(clientProviderDenial(owner, "anthropic-subscription")).toBeNull();
        expect(clientProviderDenial(owner, "xai-api-key")).toBeNull();
    });

    it("clients are always denied subscription providers", () => {
        expect(clientProviderDenial(alice, "anthropic-subscription")).toContain("subscription");
        expect(clientProviderDenial(bob, "openai-subscription")).toContain("subscription");
    });

    it("clients without allowedProviders get any non-subscription provider", () => {
        expect(clientProviderDenial(alice, "xai-api-key")).toBeNull();
        expect(clientProviderDenial(alice, "openai")).toBeNull();
    });

    it("allowedProviders restricts to the listed set", () => {
        expect(clientProviderDenial(bob, "xai-api-key")).toBeNull();
        expect(clientProviderDenial(bob, "openai")).toContain("not allowed");
    });

    it("treats a non-array allowedProviders as unrestricted instead of throwing", () => {
        const malformed = {
            name: "eve",
            isOwner: false,
            config: { name: "eve", key: "e".repeat(24), allowedProviders: {} },
        } as unknown as Parameters<typeof clientProviderDenial>[0];
        expect(clientProviderDenial(malformed, "xai-api-key")).toBeNull();
        expect(clientProviderDenial(malformed, "anthropic-subscription")).toContain("subscription");
    });
});
