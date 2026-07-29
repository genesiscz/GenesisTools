import type { AiProxyConfig } from "@app/ai-proxy/lib/types";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { accountRef } from "@genesiscz/utils/ai/config/refs";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { logger } from "@genesiscz/utils/logger";
import { isSecureRef, type SecureRef, secrets } from "@genesiscz/utils/security";

/**
 * The proxy AS an account.
 *
 * Everything else in this file follows from one gap: the `ai-proxy` provider
 * plugin (`src/utils/ai/providers/plugins/ai-proxy.ts`) resolves its key from an
 * ACCOUNT in `~/.genesis-tools/ai/config.json`, while this tool keeps its key in
 * `~/.genesis-tools/ai-proxy/config.json`. No such account has ever existed, so
 * `resolveModel("@proxy/<slug>/<model>")` failed for every caller — which is
 * exactly why Phase 4 stopped before moving `AiProxyClient` onto the shared
 * transport (see that file's header).
 *
 * Registering the account is config work, not transport work, and it is what
 * this does: the proxy's own key goes into the vault, the AI config gets a
 * pointer to it, and `@proxy/` refs start resolving. The key is never copied
 * into the AI config as plaintext — a SecureRef is the whole point.
 */

export const GATEWAY_ACCOUNT_ID = "acc_ai_proxy";
export const GATEWAY_ACCOUNT_NAME = "ai-proxy";
export const GATEWAY_KEY_PATH = `ai/${GATEWAY_ACCOUNT_ID}/apiKey`;
export const GATEWAY_ACCOUNT_REF = accountRef(GATEWAY_ACCOUNT_ID);

export function gatewayEndpoint(config: AiProxyConfig): string {
    const host = config.listen.host === "0.0.0.0" ? "127.0.0.1" : config.listen.host;
    return `http://${host}:${config.listen.port}/v1`;
}

export interface GatewayAccountStatus {
    linked: boolean;
    accountId: string;
    ref: string;
    /** The endpoint the AI config currently points at, when linked. */
    endpoint?: string;
    /** True when the stored credential is a vault pointer rather than a literal. */
    secured: boolean;
    detail: string;
}

export async function gatewayAccountStatus(): Promise<GatewayAccountStatus> {
    const store = await AiConfigStore.load();
    const account = store.account(GATEWAY_ACCOUNT_ID);

    if (!account) {
        return {
            linked: false,
            accountId: GATEWAY_ACCOUNT_ID,
            ref: GATEWAY_ACCOUNT_REF,
            secured: false,
            detail: "no ai-proxy account in the AI config — @proxy/<slug>/<model> refs cannot resolve",
        };
    }

    const secured = isSecureRef(account.credentials.apiKey);

    return {
        linked: true,
        accountId: account.id,
        ref: GATEWAY_ACCOUNT_REF,
        endpoint: account.endpoint,
        secured,
        detail: account.enabled
            ? `linked to ${account.endpoint ?? "the default endpoint"}${secured ? "" : " (key is NOT in the vault)"}`
            : "linked but disabled — tools ai config account enable acc_ai_proxy",
    };
}

export interface GatewayLinkResult {
    created: boolean;
    accountId: string;
    endpoint: string;
    keyPath: string;
}

/**
 * Create or refresh the `ai-proxy` account from this tool's own config.
 *
 * Idempotent: rerunning after `config set port` moves the endpoint, and
 * rerunning after the proxy key is rotated re-encrypts the new one. Fields a
 * user may have edited (`name`, `label`, `enabled`, `tags`) are preserved.
 */
export async function linkGatewayAccount(config: AiProxyConfig): Promise<GatewayLinkResult> {
    if (!config.proxyApiKey) {
        throw new Error("This proxy has no proxyApiKey yet. Run: tools ai-proxy config init");
    }

    const store = await AiConfigStore.load();
    const endpoint = gatewayEndpoint(config);
    const existing = store.account(GATEWAY_ACCOUNT_ID);

    // Config lock first, vault lock second — the order AiConfigStore documents,
    // so two processes rotating a token cannot deadlock. `withLock`, not
    // `mutate`: mutate's callback is SYNC and an async one is never awaited, so
    // the vault write would land after the config had already been persisted.
    let keyRef: SecureRef | undefined;

    await store.withLock(async (data) => {
        const secretStore = await secrets();
        keyRef = await secretStore.set(GATEWAY_KEY_PATH, config.proxyApiKey);

        const entry: AccountEntry = {
            id: GATEWAY_ACCOUNT_ID,
            name: existing?.name ?? GATEWAY_ACCOUNT_NAME,
            provider: "ai-proxy",
            enabled: existing?.enabled ?? true,
            label: existing?.label ?? "Local ai-proxy gateway",
            ...(existing?.tags ? { tags: existing.tags } : {}),
            ...(existing?.apps ? { apps: existing.apps } : {}),
            // A call through the gateway is booked against whichever subscription
            // account serves it upstream, so the gateway itself meters nothing.
            billing: existing?.billing ?? { mode: "free" },
            endpoint,
            credentials: { ...existing?.credentials, apiKey: keyRef },
            useEnvApiKey: existing?.useEnvApiKey ?? false,
        };

        const index = data.accounts.findIndex((account) => account.id === GATEWAY_ACCOUNT_ID);

        if (index === -1) {
            data.accounts.push(entry);
        } else {
            data.accounts[index] = entry;
        }
    });

    logger.info(
        { account: GATEWAY_ACCOUNT_ID, endpoint, created: !existing },
        "ai-proxy: gateway account linked — @proxy refs now resolve"
    );

    return {
        created: !existing,
        accountId: GATEWAY_ACCOUNT_ID,
        endpoint,
        keyPath: keyRef?.path ?? GATEWAY_KEY_PATH,
    };
}
