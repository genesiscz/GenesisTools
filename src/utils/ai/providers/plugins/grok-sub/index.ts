import { grokHistoryReader } from "@genesiscz/utils/agent-sessions/compact-readers";
import { getLanguageModel } from "@genesiscz/utils/ask/types/provider";
import { resolveSecret } from "@genesiscz/utils/security";
import { composeAuthFetch } from "../../../core/fetch";
import type { ResolvedGrokSubToken } from "../../../grok/account";
import { decodeJwtClaims, getActiveAuthEntry, readAuthFileAsync } from "../../../grok/auth";
import { GrokAuthExpiredError } from "../../../grok/auth-errors";
import { grokAuthPath } from "../../../grok/paths";
import type { AccountFeatures } from "../../account-features";
import type { BindContext, ProviderBinding, ProviderPlugin } from "../../plugin-types";
import { discoverGrokHomes } from "./discover";
import { grokHarness } from "./harness";
import { grokLogin } from "./login";
import { grokSpendScope } from "./spend";
import { grokUsage } from "./usage";

/** How many sent tokens a binding remembers, so a 401 recovers from the grant that request used. */
const SENT_TOKENS_KEPT = 8;

/**
 * SuperGrok subscription through the Grok CLI chat proxy.
 *
 * `bind` owns the auth: the fetch it builds live-reads the token per request
 * (the CLI auth file, or the vault grant of a `tools grok login`), sends the CLI
 * identification headers the proxy 426s without, and on a 401 recovers once and
 * repeats the request once.
 */

/**
 * xAI reports the subscription allowance as whole percent over a rolling week, split by
 * product. The pay-as-you-go credit only appears when the account has on-demand spend.
 */
const presentation: AccountFeatures["presentation"] = {
    displayName: "Grok",
    alias: "grok",
    limitOrder: ["weekly", "product:grokbuild", "product:grokchat", "credit"],
    prominentLimits: ["weekly"],
};

export const grokSubPlugin: ProviderPlugin = {
    id: "grok-sub",
    codingAgent: grokHistoryReader,
    harness: grokHarness,
    kind: "subscription",
    capabilities: new Set(["chat", "summarize", "translate"]),
    credential: {
        // A named login owns a vault grant; `--home` / `--auth-file` keep a file reference.
        fields: ["authFile", "accessToken", "refreshToken"],
        envKeys: [],
    },

    async bind(ctx: BindContext): Promise<ProviderBinding> {
        // The auth file comes from THIS context, not from a second lookup by
        // name: an account object that is not in the live config still binds,
        // and a duplicate name cannot resolve to the wrong one.
        const accountId = ctx.account.id;
        const authFile = ctx.account.credentials.authFile;
        const { resolveGrokSubToken } = await import("../../../grok/account");
        // Only this initial read is gated; the per-request closure below keeps its
        // refresh, because a diagnostic caller never issues a request.
        const initial = await resolveGrokSubToken(accountId, { noRefresh: ctx.probe, authFile });

        const { GROK_CLI_CHAT_PROXY_BASE_URL } = await import("../../../grok/paths");
        const { buildCliProxyHeaders } = await import("../../../grok/headers");
        const { createOpenAI } = await import("@ai-sdk/openai");

        const sent = new Map<string, ResolvedGrokSubToken>([[initial.token, initial]]);
        const remember = (resolved: ResolvedGrokSubToken): string => {
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
        // The CLI chat proxy 426s without the Grok CLI identification headers.
        // Token + headers are resolved per REQUEST (live read) so a long-running
        // process picks up CLI-refreshed JWTs automatically.
        const freshTokenFetch = composeAuthFetch({
            getToken: async () => remember(await resolveGrokSubToken(accountId, { authFile })),
            // The 401 recovery of `GrokSubscriptionClient.fetch`: a newer token already on disk
            // (or in the vault) is used as is; the very token the upstream rejected forces one
            // grant, because a rejected token is usually still inside its `exp`.
            refresh: async (rejected) => {
                const again = await resolveGrokSubToken(accountId, { authFile });

                if (again.token !== rejected) {
                    return remember(again);
                }

                const used = sent.get(rejected) ?? initial;
                const { refreshGrokAuth } = await import("../../../grok/refresh");
                const refreshed = used.storedGrant
                    ? await used.storedGrant.refresh("upstream returned 401", true)
                    : await refreshGrokAuth({ path: used.authPath ?? grokAuthPath(), force: true });

                if (!refreshed || refreshed === rejected) {
                    throw used.storedGrant
                        ? new GrokAuthExpiredError(undefined, { hint: used.storedGrant.hint })
                        : new GrokAuthExpiredError(used.authPath);
                }

                return remember({ ...used, token: refreshed });
            },
            authorize: (headers, token) => {
                for (const [name, value] of Object.entries(buildCliProxyHeaders({ token }))) {
                    headers.set(name, value);
                }
            },
            ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
        });
        const provider = createOpenAI({
            baseURL: GROK_CLI_CHAT_PROXY_BASE_URL,
            apiKey: "grok-sub-placeholder",
            fetch: freshTokenFetch,
        });

        return {
            accountId,
            providerId: "grok-sub",
            billed: false,
            language: (modelId: string) => getLanguageModel(provider, modelId, "grok-sub"),
        };
    },

    /**
     * Read-side only, per CLAUDE.md "A diagnostic must never mutate". `health` is
     * always a probe; `bind` honours `ctx.probe` so testing an account observes
     * it instead of changing it.
     */
    async health(ctx: BindContext) {
        try {
            const { resolveGrokSubToken } = await import("../../../grok/account");
            await resolveGrokSubToken(ctx.account.id, { noRefresh: true, authFile: ctx.account.credentials.authFile });
            return { ok: true, detail: "grok CLI token resolved" };
        } catch (err) {
            return { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
    },

    accounts: {
        presentation,
        login: grokLogin,
        // `--home` and `--auth-file` are the core's; Grok's own flow takes no switch.
        loginFlags: [],
        // The `claude` and `ask` defaults stay Anthropic's: a Grok login there would retarget them.
        loginApps: [],
        // Grok keeps no refresh cooldown to retire; the core clears the poll gate itself.
        afterLogin: async () => {},
        // No long-lived token and no secondary grant.
        loginVariants: {},
        nativeAuthFile: () => grokAuthPath(),
        logoutTargets: ["oauth", "authFile"],
        usage: grokUsage,
        discoverHomes: () => discoverGrokHomes(),

        /**
         * Claims out of the auth file the account references, or out of its stored grant.
         * Decode only, no OIDC grant; resolving the stored token is a READ.
         */
        async identityOf(account) {
            const authFile = account.credentials.authFile;
            const token = authFile
                ? getActiveAuthEntry(await readAuthFileAsync(authFile))?.key
                : await resolveSecret(account.credentials.accessToken);
            const claims = token ? decodeJwtClaims(token) : null;

            if (!claims) {
                return undefined;
            }

            return {
                accountUuid: claims.sub,
                ...(claims.tier === undefined ? {} : { plan: `tier ${claims.tier}` }),
            };
        },

        spendScope: (account) => grokSpendScope(account),
    },
};
