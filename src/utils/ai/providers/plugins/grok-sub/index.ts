import { getLanguageModel } from "@genesiscz/utils/ask/types/provider";
import { decodeJwtClaims, getActiveAuthEntry, readAuthFileAsync } from "../../../grok/auth";
import { grokAuthPath, resolveGrokHome } from "../../../grok/paths";
import { GrokSubResolver } from "../../../resolvers/GrokSubResolver";
import type { AccountFeatures } from "../../account-features";
import type { BindContext, ProviderBinding, ProviderPlugin } from "../../plugin-types";
import { discoverGrokHomes } from "./discover";
import { grokSpendScope } from "./spend";
import { grokUsage } from "./usage";

/**
 * SuperGrok subscription through the Grok CLI chat proxy.
 *
 * Wraps the existing resolver, which live-reads the CLI auth file per request
 * and sends the CLI identification headers the proxy 426s without.
 */
const resolver = new GrokSubResolver();

/** xAI reports one window: the monthly billing credit (`used` against `monthlyLimit`). */
const presentation: AccountFeatures["presentation"] = {
    displayName: "Grok",
    alias: "grok",
    limitOrder: ["monthly"],
    prominentLimits: ["monthly"],
};

export const grokSubPlugin: ProviderPlugin = {
    id: "grok-sub",
    kind: "subscription",
    capabilities: new Set(["chat", "summarize", "translate"]),
    credential: {
        fields: ["authFile"],
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
        logoutTargets: ["authFile"],
        usage: grokUsage,
        discoverHomes: () => discoverGrokHomes(),

        /**
         * No `login`: xAI has no in-process flow, so the Grok CLI does the browser
         * round-trip and we bind the file it writes.
         */
        externalLogin(ctx) {
            const home = ctx.home ?? resolveGrokHome();

            return {
                command: ["grok", "login"],
                env: { GROK_HOME: home },
                authFile: ctx.authFile ?? grokAuthPath(home),
            };
        },

        /** Claims out of the auth file the account references. Decode only, no OIDC grant. */
        async identityOf(account) {
            const authFile = account.credentials.authFile;

            if (!authFile) {
                return undefined;
            }

            const active = getActiveAuthEntry(await readAuthFileAsync(authFile));
            const claims = active ? decodeJwtClaims(active.key) : null;

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
