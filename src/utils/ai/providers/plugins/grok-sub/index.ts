import { grokHistoryReader } from "@genesiscz/utils/agent-sessions/compact-readers";
import { getLanguageModel } from "@genesiscz/utils/ask/types/provider";
import { resolveSecret } from "@genesiscz/utils/security";
import { decodeJwtClaims, getActiveAuthEntry, readAuthFileAsync } from "../../../grok/auth";
import { grokAuthPath } from "../../../grok/paths";
import { GrokSubResolver } from "../../../resolvers/GrokSubResolver";
import type { AccountFeatures } from "../../account-features";
import type { BindContext, ProviderBinding, ProviderPlugin } from "../../plugin-types";
import { discoverGrokHomes } from "./discover";
import { grokLogin } from "./login";
import { grokSpendScope } from "./spend";
import { grokUsage } from "./usage";

/**
 * SuperGrok subscription through the Grok CLI chat proxy.
 *
 * Wraps the existing resolver, which live-reads the CLI auth file per request
 * and sends the CLI identification headers the proxy 426s without.
 */
const resolver = new GrokSubResolver();

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
        const detected = await resolver.resolve(ctx.account.name, {
            noRefresh: ctx.probe,
            authFile: ctx.account.credentials.authFile,
        });

        return {
            accountId: ctx.account.id,
            providerId: "grok-sub",
            billed: false,
            language: (modelId: string) => getLanguageModel(detected.provider, modelId, "grok-sub"),
        };
    },

    /**
     * Read-side only, per CLAUDE.md "A diagnostic must never mutate". `health` is
     * always a probe; `bind` honours `ctx.probe` so testing an account observes
     * it instead of changing it.
     */
    async health(ctx: BindContext) {
        try {
            await resolver.resolve(ctx.account.name, { noRefresh: true, authFile: ctx.account.credentials.authFile });
            return { ok: true, detail: "grok CLI token resolved" };
        } catch (err) {
            return { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
    },

    accounts: {
        presentation,
        login: grokLogin,
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
