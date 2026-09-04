import { getLanguageModel } from "@genesiscz/utils/ask/types/provider";
import { AnthropicSubResolver } from "../../../resolvers/AnthropicSubResolver";
import type { AccountFeatures } from "../../account-features";
import type { BindContext, ProviderBinding, ProviderPlugin } from "../../plugin-types";
import { anthropicLogin } from "./login";
import { anthropicLoginLong } from "./login-long";
import { anthropicLoginSecondary } from "./login-secondary";

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
 * `limitOrder` is `VISIBLE_BUCKETS` (`src/claude/lib/usage/constants.ts`) plus
 * `extra_usage`, copied rather than imported: `src/utils/` must not depend on a
 * tool folder. `prominentLimits` are the keys the usage mapper emits for the
 * compact views (TUI overview, menubar).
 */
const presentation: AccountFeatures["presentation"] = {
    displayName: "Claude",
    alias: "claude",
    limitOrder: ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_oauth_apps", "extra_usage"],
    prominentLimits: ["five_hour", "seven_day", "seven_day_sonnet"],
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
