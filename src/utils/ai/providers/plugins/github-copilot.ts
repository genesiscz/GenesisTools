import { createOpenAI } from "@ai-sdk/openai";
import { copilotDataDir, GithubCopilotApi, getCopilotSession } from "@genesiscz/utils/ai/github-copilot";
import type { BindContext, ProviderBinding, ProviderPlugin } from "../plugin-types";

/**
 * GitHub Copilot subscription.
 *
 * Unlike the other subscription providers there is no resolver to wrap: the auth
 * dance (gho token → short-lived session token → per-request Copilot headers,
 * with a refresh on 401) already lives in `GithubCopilotApi`, so the plugin
 * borrows that client as its transport instead of re-implementing it.
 *
 * `createOpenAI` needs a base URL to build request URLs from, but the real host
 * is only known after a session exists (individual and business plans differ).
 * The SDK therefore gets a sentinel base whose only job is to carry the path,
 * which the custom fetch hands to the client — the client resolves the true host.
 */
const SENTINEL_BASE_URL = "https://github-copilot.invalid/v1";

function copilotFetch(api: GithubCopilotApi): typeof fetch {
    const delegate = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const path = `${url.pathname.replace(/^\/v1/, "")}${url.search}`;
        const body = init?.body;

        return api.fetch(path, {
            ...init,
            ...(typeof body === "string" ? { bodyText: body } : {}),
        });
    };

    // `typeof fetch` also carries `preconnect`, which no caller here uses.
    return delegate as typeof fetch;
}

export const githubCopilotPlugin: ProviderPlugin = {
    id: "github-copilot",
    kind: "subscription",
    capabilities: new Set(["chat", "summarize", "translate"]),
    credential: {
        // The gho token lives in the Copilot CLI data dir (or the keychain entry
        // keyed by it), never in this config.
        fields: ["dataDir"],
        envKeys: [],
    },

    async bind(ctx: BindContext): Promise<ProviderBinding> {
        // A probe binds to REPORT, so prove a live session exists without minting
        // one: minting rewrites the session cache every other process reads.
        if (ctx.probe) {
            await getCopilotSession(copilotDataDir(ctx.account.credentials.dataDir), { noMint: true });
        }

        const api = new GithubCopilotApi({ dataDir: ctx.account.credentials.dataDir });
        const provider = createOpenAI({
            apiKey: "github-copilot-session",
            baseURL: SENTINEL_BASE_URL,
            fetch: copilotFetch(api),
        });

        return {
            accountId: ctx.account.id,
            providerId: "github-copilot",
            billed: false,
            language: (modelId: string) => provider.languageModel(modelId),
        };
    },

    /**
     * Read-side only, per CLAUDE.md "A diagnostic must never mutate". `health` is
     * always a probe; `bind` honours `ctx.probe` so testing an account observes
     * it instead of changing it.
     */
    async health(ctx: BindContext) {
        try {
            const session = await getCopilotSession(copilotDataDir(ctx.account.credentials.dataDir), {
                noMint: true,
            });
            return { ok: true, detail: `copilot session valid until ${new Date(session.expiresAtMs).toISOString()}` };
        } catch (err) {
            return { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
    },
};
