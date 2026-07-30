import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    _resetClientKeyCacheForTest,
    clientProviderDenial,
    OWNER_CLIENT_NAME,
    resolveClient,
    SUBSCRIPTION_PROVIDER_TYPES,
    validateClients,
} from "@app/ai-proxy/lib/clients";
import type { AiProxyClientConfig, AiProxyConfig } from "@app/ai-proxy/lib/types";
import { env } from "@genesiscz/utils/env";
import { _resetSecretsForTest, invalidateMasterKeyCache, secrets, secureRef } from "@genesiscz/utils/security";

const good: AiProxyClientConfig = { name: "alice", key: "k".repeat(24) };

const ERIN_PATH = "ai-proxy/clients/erin/key";
const DAVE_PATH = "ai-proxy/clients/dave/key";

/**
 * Whole seconds on purpose: `statSync().mtimeMs` is a float carrying
 * sub-millisecond precision, so copying one file's `mtime` Date onto another
 * truncates and the two stamps still differ. Pinning both vaults to the same
 * integer is the only way to make mtime genuinely tie.
 */
const PINNED_MTIME_SEC = 1_700_000_000;

function vaultFile(home: string): string {
    return join(home, ".genesis-tools", "security", "vault.json");
}

/** Every in-process cache a config-root swap has to invalidate. */
function resetSecurityState(): void {
    _resetSecretsForTest();
    invalidateMasterKeyCache();
    _resetClientKeyCacheForTest();
}

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
        expect(problems.some((p) => p.includes("key must be a vault reference or a string"))).toBe(true);
        expect(problems.some((p) => p.includes("allowedProviders must be an array"))).toBe(true);
    });

    it("accepts a vault reference as a key without reading it", () => {
        const secured: AiProxyClientConfig = { name: "alice", key: secureRef("ai-proxy/clients/alice/key") };
        expect(validateClients([secured])).toEqual([]);
        expect(validateClients([secured, { ...secured, name: "bob" }]).some((p) => p.includes("duplicate"))).toBe(true);
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
    it("resolves proxyApiKey to the owner identity", async () => {
        const resolved = await resolveClient(reqWithBearer("owner-key-0123456789"), cfg());
        expect(resolved).toEqual({ name: "owner", isOwner: true });
    });

    it("resolves a client key to its named identity", async () => {
        const alice = { name: "alice", key: "alice-key-0123456789" };
        const resolved = await resolveClient(reqWithBearer("alice-key-0123456789"), cfg([alice]));
        expect(resolved?.name).toBe("alice");
        expect(resolved?.isOwner).toBe(false);
        expect(resolved?.config).toEqual(alice);
    });

    it("rejects wrong keys, missing header, and disabled clients", async () => {
        const disabled = { name: "mallory", key: "mallory-key-0123456", disabled: true };
        expect(await resolveClient(reqWithBearer("nope-nope-nope-nope"), cfg([disabled]))).toBeNull();
        expect(await resolveClient(reqWithBearer(null), cfg())).toBeNull();
        expect(await resolveClient(reqWithBearer("mallory-key-0123456"), cfg([disabled]))).toBeNull();
    });

    it("skips a non-string client key and doesn't throw", async () => {
        const malformed = { name: "mallory", key: 12345 } as unknown as NonNullable<AiProxyConfig["clients"]>[number];
        expect(await resolveClient(reqWithBearer("owner-key-0123456789"), cfg([malformed]))).toEqual({
            name: "owner",
            isOwner: true,
        });
        expect(await resolveClient(reqWithBearer("anything"), cfg([malformed]))).toBeNull();
    });

    it("treats a non-array clients config as empty instead of throwing", async () => {
        const malformed = { owner: true } as unknown as AiProxyConfig["clients"];
        expect(await resolveClient(reqWithBearer("owner-key-0123456789"), cfg(malformed))).toEqual({
            name: "owner",
            isOwner: true,
        });
    });

    it("authenticates a client whose key lives in the vault", async () => {
        const home = mkdtempSync(join(tmpdir(), "aiproxy-clients-"));

        await env.testing.withOverrides(
            { GENESIS_TOOLS_HOME: home, GENESIS_TOOLS_MASTER_KEY: randomBytes(32).toString("base64") },
            async () => {
                resetSecurityState();
                const store = await secrets();
                const ref = await store.set("ai-proxy/clients/carol/key", "carol-key-0123456789");
                const carol = { name: "carol", key: ref };

                expect((await resolveClient(reqWithBearer("carol-key-0123456789"), cfg([carol])))?.name).toBe("carol");
                expect(await resolveClient(reqWithBearer("not-carols-key-01234"), cfg([carol]))).toBeNull();
            }
        );

        resetSecurityState();
    });

    it("denies a client whose vault reference no longer resolves", async () => {
        const ghost = { name: "ghost", key: secureRef("ai-proxy/clients/ghost/key") };
        expect(await resolveClient(reqWithBearer("ghost-key-0123456789"), cfg([ghost]))).toBeNull();
    });

    it("stops authenticating a cached key once the vault is rewritten", async () => {
        const home = mkdtempSync(join(tmpdir(), "aiproxy-clients-rot-"));

        await env.testing.withOverrides(
            { GENESIS_TOOLS_HOME: home, GENESIS_TOOLS_MASTER_KEY: randomBytes(32).toString("base64") },
            async () => {
                resetSecurityState();
                const store = await secrets();
                const erin = { name: "erin", key: await store.set(ERIN_PATH, "erin-old-key-012345") };

                expect((await resolveClient(reqWithBearer("erin-old-key-012345"), cfg([erin])))?.name).toBe("erin");

                await store.set(ERIN_PATH, "erin-new-key-012345");

                expect(await resolveClient(reqWithBearer("erin-old-key-012345"), cfg([erin]))).toBeNull();
                expect((await resolveClient(reqWithBearer("erin-new-key-012345"), cfg([erin])))?.name).toBe("erin");
            }
        );

        resetSecurityState();
    });

    /**
     * The cache identity has to carry the vault PATH, not just its mtime: one
     * process can point at two config roots, and the same logical secret path
     * means different plaintext in each. The two vaults are forced to share an
     * mtime here so the path is the only thing left that can tell them apart.
     * Otherwise the test passes for the wrong reason.
     */
    it("does not serve one config root's cached key out of another root's vault", async () => {
        const homeA = mkdtempSync(join(tmpdir(), "aiproxy-clients-a-"));
        const homeB = mkdtempSync(join(tmpdir(), "aiproxy-clients-b-"));
        const masterKey = randomBytes(32).toString("base64");
        const dave = { name: "dave", key: secureRef(DAVE_PATH) };

        await env.testing.withOverrides(
            { GENESIS_TOOLS_HOME: homeA, GENESIS_TOOLS_MASTER_KEY: masterKey },
            async () => {
                resetSecurityState();
                await (await secrets()).set(DAVE_PATH, "dave-in-root-a-01234");
                utimesSync(vaultFile(homeA), PINNED_MTIME_SEC, PINNED_MTIME_SEC);
                expect((await resolveClient(reqWithBearer("dave-in-root-a-01234"), cfg([dave])))?.name).toBe("dave");
            }
        );

        await env.testing.withOverrides(
            { GENESIS_TOOLS_HOME: homeB, GENESIS_TOOLS_MASTER_KEY: masterKey },
            async () => {
                // Deliberately NOT clearing the client-key cache: switching roots has
                // to invalidate it on its own.
                _resetSecretsForTest();
                invalidateMasterKeyCache();
                await (await secrets()).set(DAVE_PATH, "dave-in-root-b-01234");
                utimesSync(vaultFile(homeB), PINNED_MTIME_SEC, PINNED_MTIME_SEC);

                expect(statSync(vaultFile(homeB)).mtimeMs).toBe(statSync(vaultFile(homeA)).mtimeMs);
                expect(await resolveClient(reqWithBearer("dave-in-root-a-01234"), cfg([dave]))).toBeNull();
                expect((await resolveClient(reqWithBearer("dave-in-root-b-01234"), cfg([dave])))?.name).toBe("dave");
            }
        );

        resetSecurityState();
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
