import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig } from "@app/ai-proxy/lib/config-store";
import {
    GATEWAY_ACCOUNT_ID,
    GATEWAY_KEY_PATH,
    gatewayAccountStatus,
    gatewayEndpoint,
    linkGatewayAccount,
} from "@app/ai-proxy/lib/gateway-account";
import type { AiProxyConfig } from "@app/ai-proxy/lib/types";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { resolveModelTarget } from "@genesiscz/utils/ai/core/resolve";
import { env } from "@genesiscz/utils/env";
import { _resetSecretsForTest, invalidateMasterKeyCache, isSecureRef, secrets } from "@genesiscz/utils/security";

function proxyConfig(port = 8317): AiProxyConfig {
    return { ...getDefaultConfig(), proxyApiKey: "aipx-test-key-0123456789", listen: { host: "127.0.0.1", port } };
}

let snapshot: ReturnType<typeof env.testing.snapshot> | undefined;

beforeEach(() => {
    snapshot = env.testing.snapshot();
    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "aiproxy-gateway-")));
    env.testing.set("GENESIS_TOOLS_MASTER_KEY", randomBytes(32).toString("base64"));
    AiConfigStore.invalidate();
    _resetSecretsForTest();
    invalidateMasterKeyCache();
});

afterEach(() => {
    if (snapshot) {
        env.testing.restore(snapshot);
    }

    AiConfigStore.invalidate();
    _resetSecretsForTest();
    invalidateMasterKeyCache();
});

describe("gateway-account", () => {
    it("derives the endpoint from the proxy's own listen config", () => {
        expect(gatewayEndpoint(proxyConfig(9001))).toBe("http://127.0.0.1:9001/v1");
        // A proxy bound to every interface is still reached locally.
        expect(gatewayEndpoint({ ...proxyConfig(), listen: { host: "0.0.0.0", port: 8317 } })).toBe(
            "http://127.0.0.1:8317/v1"
        );
    });

    it("reports the missing link before anything is created", async () => {
        const status = await gatewayAccountStatus();

        expect(status.linked).toBe(false);
        expect(status.detail).toContain("@proxy/<slug>/<model> refs cannot resolve");
    });

    it("stores the proxy key in the vault and points the AI config at it", async () => {
        const result = await linkGatewayAccount(proxyConfig());

        expect(result).toMatchObject({ created: true, accountId: GATEWAY_ACCOUNT_ID, keyPath: GATEWAY_KEY_PATH });

        const account = (await AiConfigStore.load()).account(GATEWAY_ACCOUNT_ID);
        expect(account?.provider).toBe("ai-proxy");
        expect(account?.endpoint).toBe("http://127.0.0.1:8317/v1");
        // The key itself must never land in the AI config.
        expect(isSecureRef(account?.credentials.apiKey)).toBe(true);
        expect(await (await secrets()).get(GATEWAY_KEY_PATH)).toBe("aipx-test-key-0123456789");
    });

    it("is idempotent: relinking moves the endpoint and keeps user-edited fields", async () => {
        await linkGatewayAccount(proxyConfig());

        const store = await AiConfigStore.load();
        await store.mutate((data) => {
            const account = data.accounts.find((entry) => entry.id === GATEWAY_ACCOUNT_ID);
            if (account) {
                account.label = "my proxy";
            }
        });

        const again = await linkGatewayAccount(proxyConfig(9100));
        expect(again.created).toBe(false);

        const account = (await AiConfigStore.load()).account(GATEWAY_ACCOUNT_ID);
        expect(account?.endpoint).toBe("http://127.0.0.1:9100/v1");
        expect(account?.label).toBe("my proxy");
        expect((await AiConfigStore.load()).accounts({ provider: "ai-proxy" })).toHaveLength(1);
    });

    it("unblocks @proxy model refs, which do not resolve before the link", async () => {
        // The exact failure Phase 4 Task 5 stopped on, reproduced first.
        await expect(resolveModelTarget("@proxy/grok/grok-4.5")).rejects.toThrow(
            /No enabled account for provider "ai-proxy"/
        );

        await linkGatewayAccount(proxyConfig());

        const target = await resolveModelTarget("@proxy/grok/grok-4.5");
        expect(target.account.id).toBe(GATEWAY_ACCOUNT_ID);
        expect(target.plugin.id).toBe("ai-proxy");
        // The gateway's own grammar is `<slug>/<model>`; the ref halves spell it.
        expect(target.model.id).toBe("grok/grok-4.5");
    });

    it("refuses to link a proxy that has no key yet", async () => {
        await expect(linkGatewayAccount({ ...proxyConfig(), proxyApiKey: "" })).rejects.toThrow(
            /tools ai-proxy config init/
        );
    });
});
