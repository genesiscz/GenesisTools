import { claudeHistoryReader } from "@genesiscz/utils/agent-sessions/compact-readers";
import { getLanguageModel } from "@genesiscz/utils/ask/types/provider";
import { clearInvalidGrant, type InferenceToken } from "@genesiscz/utils/claude/subscription-auth";
import { composeAuthFetch } from "../../../core/fetch";
import type { AccountFeatures } from "../../account-features";
import type { BindContext, ProviderBinding, ProviderPlugin } from "../../plugin-types";
import { LIMIT_ORDER, PROMINENT_LIMITS } from "./buckets";
import { claudeHarness } from "./harness";
import { anthropicLogin } from "./login";
import { anthropicLongLogin } from "./login-long";
import { anthropicSecondaryLogin } from "./login-secondary";
import { anthropicSpendScope } from "./spend";
import { anthropicUsage } from "./usage";
import { anthropicWarmup } from "./warmup";

/** How many sent tokens a binding remembers, so a 401 recovers from the token that request sent. */
const SENT_TOKENS_KEPT = 8;

/**
 * Claude Max/Pro subscription.
 *
 * `bind` owns the auth: the fetch it builds resolves the token per REQUEST (a
 * long-running process otherwise serves a token another process already rotated
 * away), and on a 401 it recovers once and repeats the request once. Recovery
 * drops a rejected long-lived token for the OAuth pair, or force-refreshes a
 * rejected access token through `storeRefreshedTokens`, which compares the stored
 * refresh token inside the config lock before it spends it.
 */

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
    codingAgent: claudeHistoryReader,
    harness: claudeHarness,
    kind: "subscription",
    capabilities: new Set(["chat", "summarize", "translate"]),
    credential: {
        // Tokens live on the account, but `bind` reads them itself through
        // subscription-auth so refreshes stay atomic. Nothing is required here.
        fields: ["accessToken", "refreshToken"],
        envKeys: [],
    },

    async bind(ctx: BindContext): Promise<ProviderBinding> {
        const accountId = ctx.account.id;
        const { recoverInferenceToken, resolveInferenceToken } = await import(
            "@genesiscz/utils/claude/subscription-auth"
        );
        // Binding for a diagnosis must not rotate the grant; binding for real use
        // still refreshes, because that is what makes the next request work.
        // `probe` gates only this initial read. The per-request closures below
        // keep their refresh, because a diagnostic caller never issues a request.
        // The long-lived token wins when the account has one, so binding an account
        // whose OAuth pair expired no longer spends (or fails on) its refresh token.
        const initial = await resolveInferenceToken(accountId, { noRefresh: ctx.probe });

        const { createSubscriptionFetch, SUBSCRIPTION_BETAS, SUBSCRIPTION_SYSTEM_PREFIX } = await import(
            "@genesiscz/utils/claude/subscription-billing"
        );

        // `createSubscriptionFetch` stays underneath because it also strips
        // x-api-key and injects the billing block. Each request recovers from the
        // token IT sent: a shared "current" let one request's 401 recover from a
        // token another request had just resolved.
        const sent = new Map<string, InferenceToken>([[initial.token, initial]]);
        const remember = (resolved: InferenceToken): string => {
            sent.delete(resolved.token);
            sent.set(resolved.token, resolved);

            while (sent.size > SENT_TOKENS_KEPT) {
                const oldest = sent.keys().next().value;

                if (oldest === undefined) {
                    break;
                }

                sent.delete(oldest);
            }

            return resolved.token;
        };
        const freshTokenFetch = composeAuthFetch({
            getToken: async () => remember(await resolveInferenceToken(accountId)),
            refresh: async (rejected) =>
                remember(await recoverInferenceToken(accountId, sent.get(rejected) ?? initial)),
            fetch: createSubscriptionFetch(ctx.fetch),
        });

        const { createAnthropic } = await import("@ai-sdk/anthropic");
        const provider = createAnthropic({
            apiKey: "oauth-placeholder",
            headers: {
                "anthropic-beta": SUBSCRIPTION_BETAS,
            },
            fetch: freshTokenFetch,
        });

        return {
            accountId,
            providerId: "anthropic-sub",
            billed: false,
            systemPromptPrefix: SUBSCRIPTION_SYSTEM_PREFIX,
            language: (modelId: string) => getLanguageModel(provider, modelId, "anthropic-sub"),
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
            const { resolveInferenceToken } = await import("@genesiscz/utils/claude/subscription-auth");
            await resolveInferenceToken(ctx.account.id, { noRefresh: true });
            return { ok: true, detail: "subscription token resolved" };
        } catch (err) {
            return { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
    },

    accounts: {
        presentation,
        logoutTargets: ["oauth", "longLived", "secondary"],
        login: anthropicLogin,
        // OAuth only: no credential file to bind, and the flow takes no switch.
        loginFlags: [],
        // Only an Anthropic login ever made itself the default of `claude` and `ask`.
        loginApps: ["claude", "ask"],
        // A fresh grant retires the invalid-grant cooldown the dead one earned.
        afterLogin: (account) => clearInvalidGrant(account.name),
        loginVariants: { long: anthropicLongLogin, secondary: anthropicSecondaryLogin },
        usage: anthropicUsage,
        warmup: anthropicWarmup,

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

        spendScope: anthropicSpendScope,
    },
};
