import { join } from "node:path";
import { codexHistoryReader } from "@genesiscz/utils/agent-sessions/compact-readers";
import { getLanguageModel } from "@genesiscz/utils/ask/types/provider";
import { primaryCodexHome } from "@genesiscz/utils/providers/session-paths";
import { resolveSecret } from "@genesiscz/utils/security";
import { composeAuthFetch } from "../../../core/fetch";
import {
    CODEX_AUTH_PATH,
    extractAccountId,
    extractEmail,
    extractPlanType,
    readCodexAuthJson,
    WHAM_BASE_URL,
} from "../../../openai/codex-auth";
import type { AccountFeatures } from "../../account-features";
import type { BindContext, ProviderBinding, ProviderPlugin } from "../../plugin-types";
import { discoverCodexHomes } from "./discover";
import { codexHarness } from "./harness";
import { BROKER_FLAG, codexLogin } from "./login";
import { codexSpendScope } from "./spend";
import { codexUsage } from "./usage";

/**
 * Codex (ChatGPT plan) subscription over the WHAM endpoint.
 *
 * `bind` makes no network request: it neither lists models (the catalog answers
 * "is this model known", and the picker asks `listModels`) nor reads a token. The
 * fetch it builds owns the auth: the token is read for each request, so a
 * long-running process follows the Codex CLI's refreshes, and on a 401 it
 * force-refreshes once (under the config lock, in `CodexAccountBinding`) and
 * repeats the request once.
 */
/**
 * The two plan-wide window slots the Codex app-server reports. Per-model pools
 * (`primary:codex_bengalfox`) follow in the order the account lists them.
 */
const presentation: AccountFeatures["presentation"] = {
    displayName: "Codex",
    alias: "codex",
    limitOrder: ["primary", "secondary"],
    prominentLimits: ["primary", "secondary"],
};

export const openAiSubPlugin: ProviderPlugin = {
    id: "openai-sub",
    codingAgent: codexHistoryReader,
    harness: codexHarness,
    kind: "subscription",
    capabilities: new Set(["chat", "summarize", "translate"]),
    credential: {
        // Named login owns a vault grant; explicit native imports retain a read-only file reference.
        fields: ["authFile", "accessToken", "refreshToken"],
        envKeys: [],
    },

    async bind(ctx: BindContext): Promise<ProviderBinding> {
        const { CodexAccountBinding } = await import("../../../openai/account-binding");
        const binding = await CodexAccountBinding.create(ctx.account.id, { allowRefresh: !ctx.probe });

        // A diagnosis reads the stored tokens once, without a refresh, so `account test` still
        // reports a dead credential. Real use reads them per request, where a refresh may run.
        if (ctx.probe) {
            await binding.tokens();
        }

        const { createOpenAI } = await import("@ai-sdk/openai");
        const { fetchWhamResponse } = await import("../../../openai/wham-request");
        // Per-request token resolve so a long-running process follows CLI /
        // account refreshes instead of serving the token from bind time. The
        // workspace id is fixed for a binding (`CodexAccountBinding` refuses an
        // identity change), so the last one read is the one every token carries.
        let workspace: string | undefined;
        const remember = (tokens: { accessToken: string; chatgptAccountId: string }): string => {
            workspace = tokens.chatgptAccountId;
            return tokens.accessToken;
        };
        // WHAM requires SSE even for SDK doGenerate calls. The transport restores
        // the requested response mode after applying the backend's request dialect.
        const freshTokenFetch = composeAuthFetch({
            getToken: async () => remember(await binding.tokens()),
            // Recover from the token THIS request sent: when another request already moved the
            // account to a newer token, that one is used and nothing is spent.
            refresh: async (rejected) => {
                const current = await binding.tokens();

                if (current.accessToken !== rejected) {
                    return remember(current);
                }

                return remember(await binding.tokens({ forceRefresh: true }));
            },
            authorize: (headers, token) => {
                headers.set("Authorization", `Bearer ${token}`);

                if (workspace) {
                    headers.set("ChatGPT-Account-Id", workspace);
                }
            },
            fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
                fetchWhamResponse({ input, init, ...(ctx.fetch ? { fetch: ctx.fetch } : {}) })) as typeof fetch,
        });
        const provider = createOpenAI({
            apiKey: "codex-sub-placeholder",
            baseURL: WHAM_BASE_URL,
            fetch: freshTokenFetch as typeof fetch,
        });

        return {
            accountId: ctx.account.id,
            providerId: "openai-sub",
            billed: false,
            language: (modelId: string) => getLanguageModel(provider, modelId, "openai-sub"),
        };
    },

    /**
     * Read-side only, per CLAUDE.md "A diagnostic must never mutate". `health` is
     * always a probe; `bind` honours `ctx.probe` so testing an account observes
     * it instead of changing it.
     */
    async health(ctx: BindContext) {
        try {
            const { CodexAccountBinding } = await import("../../../openai/account-binding");
            const binding = await CodexAccountBinding.create(ctx.account.id, { allowRefresh: false });
            await binding.tokens();
            return { ok: true, detail: "codex subscription token resolved" };
        } catch (err) {
            return { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
    },

    async listModels(ctx: BindContext) {
        const { listOpenAiSubModels } = await import("./models");
        return listOpenAiSubModels(ctx.account);
    },

    accounts: {
        presentation,
        logoutTargets: ["oauth", "authFile"],
        login: codexLogin,
        loginFlags: [BROKER_FLAG],
        // The `claude` and `ask` defaults stay Anthropic's: a Codex login there would retarget them.
        loginApps: [],
        // Codex keeps no refresh cooldown to retire; the core clears the poll gate itself.
        afterLogin: async () => {},
        // No long-lived token and no secondary grant.
        loginVariants: {},
        nativeAuthFile: () => {
            // The primary entry, not the raw variable: `CODEX_HOME` is a comma-separated list,
            // and joining the whole string produced `~/.codex-a,~/.codex-b/auth.json`, which
            // `--import-native` then reported as "no native credential".
            const nativeHome = primaryCodexHome();
            return nativeHome ? join(nativeHome, "auth.json") : CODEX_AUTH_PATH;
        },
        usage: codexUsage,
        discoverHomes: () => discoverCodexHomes(),

        /** JWT claims from the auth file or the stored token. Decode only, no network. */
        async identityOf(account) {
            const authFile = account.credentials.authFile;
            const tokens = authFile ? await readCodexAuthJson(authFile) : null;
            // The stored access token is the last resort, and it is a `MaybeSecret`:
            // an account whose credential lives in the vault holds a `SecureRef`
            // object here, which the JWT decoders cannot read. Resolving it first
            // is a READ, so this stays a diagnostic (PR #360 review t16).
            const claims =
                tokens?.idToken ?? tokens?.accessToken ?? (await resolveSecret(account.credentials.accessToken));

            if (!claims) {
                return account.accountUuid ? { accountUuid: account.accountUuid, plan: account.label } : undefined;
            }

            return {
                email: extractEmail(claims),
                accountUuid: tokens?.accountId ?? extractAccountId(claims),
                plan: extractPlanType(claims) ?? account.label,
            };
        },

        spendScope: codexSpendScope,
    },
};
