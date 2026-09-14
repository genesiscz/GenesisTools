import { join } from "node:path";
import { codexHistoryReader } from "@genesiscz/utils/agent-sessions/compact-readers";
import { getLanguageModel } from "@genesiscz/utils/ask/types/provider";
import { primaryCodexHome } from "@genesiscz/utils/providers/session-paths";
import { resolveSecret } from "@genesiscz/utils/security";
import {
    CODEX_AUTH_PATH,
    extractAccountId,
    extractEmail,
    extractPlanType,
    readCodexAuthJson,
} from "../../../openai/codex-auth";
import { OpenAISubResolver } from "../../../resolvers/OpenAISubResolver";
import type { AccountFeatures } from "../../account-features";
import type { BindContext, ProviderBinding, ProviderPlugin } from "../../plugin-types";
import { discoverCodexHomes } from "./discover";
import { codexLogin } from "./login";
import { codexSpendScope } from "./spend";
import { codexUsage } from "./usage";

/**
 * Codex (ChatGPT plan) subscription over the WHAM endpoint.
 *
 * Wraps the existing resolver: its per-request token resolution keeps a
 * long-running process following the Codex CLI's refreshes, which is exactly the
 * behaviour that must not change while storage moves under it.
 */
const resolver = new OpenAISubResolver();

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
    kind: "subscription",
    capabilities: new Set(["chat", "summarize", "translate"]),
    credential: {
        // Named login owns a vault grant; explicit native imports retain a read-only file reference.
        fields: ["authFile", "accessToken", "refreshToken"],
        envKeys: [],
    },

    async bind(ctx: BindContext): Promise<ProviderBinding> {
        const detected = await resolver.resolve(ctx.account.id, { noRefresh: ctx.probe });

        return {
            accountId: ctx.account.id,
            providerId: "openai-sub",
            billed: false,
            language: (modelId: string) => getLanguageModel(detected.provider, modelId, "openai-sub"),
        };
    },

    /**
     * Read-side only, per CLAUDE.md "A diagnostic must never mutate". `health` is
     * always a probe; `bind` honours `ctx.probe` so testing an account observes
     * it instead of changing it.
     */
    async health(ctx: BindContext) {
        try {
            await resolver.resolve(ctx.account.id, { noRefresh: true });
            return { ok: true, detail: "codex subscription token resolved" };
        } catch (err) {
            return { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
    },

    accounts: {
        presentation,
        logoutTargets: ["oauth", "authFile"],
        login: codexLogin,
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
