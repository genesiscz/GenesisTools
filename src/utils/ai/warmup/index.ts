import { Writable } from "node:stream";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";

import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { providerPlugin } from "@genesiscz/utils/ai/providers/registry";
import { ai } from "@genesiscz/utils/ai/tasks/facade";
import { logger } from "@genesiscz/utils/logger";

export interface WarmupResult {
    accountId: string;
    accountName: string;
    provider: string;
    ok: boolean;
    durationMs: number;
    /** Which path sent the request: `chat` (the facade) or a plugin-specific route. */
    via: string;
    error?: string;
}

/** The two reads the warmup needs; tests hand in a plain object. */
export type WarmupStore = Pick<AiConfigStore, "account" | "accounts">;

export interface WarmupOptions {
    /** Plugin id (`anthropic-sub`); absent means every subscription provider. */
    provider?: string;
    /** Account names or ids; absent means every enabled account in scope. */
    names?: string[];
    store?: WarmupStore;
    /** Test seam: the per-account sender. Production sends one tiny chat turn. */
    send?: (account: AccountEntry) => Promise<{ via: string }>;
}

/**
 * The smallest model a provider offers, so a warmup costs as little quota as a request
 * can. Only anthropic has one the resolver understands (`haiku`); a ChatGPT account
 * rejects the static `mini` and `codex` slugs ("not supported when using Codex with a
 * ChatGPT account", 2026-09-10), so codex and grok use the account's default model.
 */
const WARMUP_MODEL: Readonly<Record<string, string>> = {
    "anthropic-sub": "haiku",
};

export function warmupModelRef(account: AccountEntry): string {
    const model = WARMUP_MODEL[account.provider];
    return model ? `@account/${account.id}:${model}` : `@account/${account.id}`;
}

/**
 * One minimal turn through the shared facade: the same request for every provider.
 * Streamed into a sink, because the codex backend only streams; the text is not wanted.
 */
export async function sendWarmupChat(account: AccountEntry): Promise<void> {
    await ai.chat({
        systemPrompt: "",
        userPrompt: "hi",
        model: warmupModelRef(account),
        task: "chat",
        app: "warmup",
        maxTokens: 5,
        streaming: true,
        streamTarget: new Writable({
            write(_chunk, _encoding, callback) {
                callback();
            },
        }),
    });
}

/**
 * The provider's own route when it declares one (anthropic falls back to its long-lived
 * token when the OAuth grant is dead), the shared chat turn otherwise.
 */
export async function sendWarmup(account: AccountEntry): Promise<{ via: string }> {
    registerBuiltInPlugins();
    const custom = providerPlugin(account.provider).accounts?.warmup;

    if (custom) {
        return custom(account, { generic: () => sendWarmupChat(account) });
    }

    await sendWarmupChat(account);
    return { via: "chat" };
}

export function selectWarmupAccounts(
    store: WarmupStore,
    opts: Pick<WarmupOptions, "provider" | "names">
): AccountEntry[] {
    if (opts.names && opts.names.length > 0) {
        return opts.names.map((selector) => {
            const account = store.account(selector);

            if (!account) {
                throw new Error(`No account named "${selector}". List them with: tools ai accounts list`);
            }

            if (opts.provider && account.provider !== opts.provider) {
                throw new Error(`Account "${selector}" belongs to ${account.provider}, not ${opts.provider}`);
            }

            return account;
        });
    }

    return store.accounts({
        enabled: true,
        billing: "subscription",
        ...(opts.provider ? { provider: opts.provider } : {}),
    });
}

/** Sequential on purpose: two warmups on one account race the same refresh token. */
export async function warmupAccounts(opts: WarmupOptions = {}): Promise<WarmupResult[]> {
    const store = opts.store ?? (await AiConfigStore.load());
    const send = opts.send ?? sendWarmup;
    const results: WarmupResult[] = [];

    for (const account of selectWarmupAccounts(store, opts)) {
        const started = performance.now();
        const base = { accountId: account.id, accountName: account.name, provider: account.provider };

        try {
            const { via } = await send(account);
            const durationMs = Math.round(performance.now() - started);
            logger.info({ ...base, via, durationMs }, "[warmup] sent");
            results.push({ ...base, ok: true, via, durationMs });
        } catch (err) {
            const durationMs = Math.round(performance.now() - started);
            const error = err instanceof Error ? err.message : String(err);
            logger.warn({ ...base, error, durationMs }, "[warmup] failed");
            results.push({ ...base, ok: false, via: "none", durationMs, error });
        }
    }

    return results;
}
