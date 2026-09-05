import { getLanguageModel } from "@genesiscz/utils/ask/types/provider";
import { AnthropicSubResolver } from "../../../resolvers/AnthropicSubResolver";
import type { AccountFeatures } from "../../account-features";
import type { BindContext, ProviderBinding, ProviderPlugin } from "../../plugin-types";
import { LIMIT_ORDER, PROMINENT_LIMITS } from "./buckets";
import { anthropicLogin } from "./login";
import { anthropicLoginLong } from "./login-long";
import { anthropicLoginSecondary } from "./login-secondary";
import { anthropicUsage } from "./usage";

/**
 * Claude Max/Pro subscription.
 *
 * Wraps the existing resolver rather than reimplementing it: its per-request
 * token resolution and 401 force-refresh dance is load-bearing (a long-running
 * process otherwise serves a token another process already rotated away), and
 * rewriting that during a storage migration would be two risky changes at once.
 */
const resolver = new AnthropicSubResolver();

/**
 * One vocabulary for the whole provider: `buckets.ts` is what the usage mapper emits and
 * what `src/claude/lib/usage/constants.ts` re-exports for the TUI, so the display order
 * here cannot drift from the keys that actually arrive.
 */
const presentation: AccountFeatures["presentation"] = {
    displayName: "Claude",
    alias: "claude",
    limitOrder: LIMIT_ORDER,
    prominentLimits: PROMINENT_LIMITS,
};

export const anthropicSubPlugin: ProviderPlugin = {
    id: "anthropic-sub",
    kind: "subscription",
    capabilities: new Set(["chat", "summarize", "translate"]),
    credential: {
        // Tokens live on the account, but the resolver reads them itself through
        // subscription-auth so refreshes stay atomic. Nothing is required here.
        fields: ["accessToken", "refreshToken"],
        envKeys: [],
    },

    async bind(ctx: BindContext): Promise<ProviderBinding> {
        // Binding for a diagnosis must not rotate the grant; binding for real use
        // still refreshes, because that is what makes the next request work.
        const detected = await resolver.resolve(ctx.account.name, { noRefresh: ctx.probe });

        return {
            accountId: ctx.account.id,
            providerId: "anthropic-sub",
            billed: false,
            systemPromptPrefix: detected.systemPromptPrefix,
            language: (modelId: string) => getLanguageModel(detected.provider, modelId, "anthropic-sub"),
        };
    },

    /**
     * Read-side only. A health probe that refreshed would spend the account's
     * single-use refresh token, and when the config write is guarded (a worktree
     * build) the rotated pair cannot be persisted, silently bricking the account.
     * An expired token is therefore REPORTED, never repaired.
     */
    async health(ctx: BindContext) {
        try {
            await resolver.resolve(ctx.account.name, { noRefresh: true });
            return { ok: true, detail: "subscription token resolved" };
        } catch (err) {
            return { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
    },

    accounts: {
        presentation,
        logoutTargets: ["oauth", "longLived", "secondary"],
        login: anthropicLogin,
        loginLong: anthropicLoginLong,
        loginSecondary: anthropicLoginSecondary,
        usage: anthropicUsage,

        /**
         * Stored fields only, never a profile fetch. Resolving an access token to
         * call the profile endpoint can refresh a single-use grant, and every
         * caller of `identityOf` is a diagnostic (`list`, `show`, the identity
         * guard before a write).
         */
        async identityOf(account) {
            const secondary = account.credentials.secondary;

            return {
                email: secondary?.emailAddress,
                accountUuid: account.accountUuid ?? secondary?.accountUuid,
                organizationUuid: account.organizationUuid ?? secondary?.organizationUuid,
                plan: account.label ?? account.subscriptionPlan,
            };
        },
    },
};
