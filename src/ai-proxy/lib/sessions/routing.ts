import { loginProviderFor } from "@app/ai-proxy/lib/providers/registry";
import { splitReasoningEffortSuffix } from "@app/ai-proxy/lib/resolve-model";
import {
    type AiProxySessionRecord,
    loginAccountName,
    SESSION_ACCOUNT_FIELD,
    SESSION_LOGIN_FIELD,
    type SessionAgent,
} from "@app/ai-proxy/lib/sessions/records";
import { agentOf } from "@app/ai-proxy/lib/sessions/view";
import type { AiProxyAccountConfig, ResolvedRoute } from "@app/ai-proxy/lib/types";

/** The agents a session names by a prefix (`codex/<id>`, `grok/<id>`); a Claude model is named by its bare id. */
const PREFIXED_AGENTS: readonly SessionAgent[] = ["codex", "grok"];

/** Claude Code strips its `[1m]` window suffix before it sends a request; another client may not. */
const ONE_M_SUFFIX = /\[1m\]$/i;

/**
 * Claude Code (2.1.310) adds a gateway's `/v1/models` entry to its `/model` picker only when the id contains "claude"
 * or "anthropic", and applies `CLAUDE_CODE_MAX_CONTEXT_TOKENS` only to an id that does not start with `claude-`
 * (any other `claude-*` id gets its 200k default). So the picker names a session model `codex-claude/<id>`, which
 * routes as `codex/<id>`.
 */
export const PICKER_ID_SUFFIX = "-claude";

/**
 * The agent a short model id names inside a session: `codex/<id>` and `grok/<id>` by their prefix (also as the
 * picker's `codex-claude/<id>`), a bare `claude-*` id by its name (P5). Every other id (a full
 * `account/provider/model`, an `@account/…` ref) is not a session form and resolves as for any client.
 */
export function sessionModelAgent(modelId: string): { agent: SessionAgent; upstreamId: string } | undefined {
    const slash = modelId.indexOf("/");

    if (slash === -1) {
        return /^claude-/i.test(modelId)
            ? { agent: "claude", upstreamId: modelId.replace(ONE_M_SUFFIX, "") }
            : undefined;
    }

    const named = modelId.slice(0, slash);
    const prefix = named.endsWith(PICKER_ID_SUFFIX) ? named.slice(0, -PICKER_ID_SUFFIX.length) : named;
    const upstreamId = modelId.slice(slash + 1);
    const agent = PREFIXED_AGENTS.find((name) => name === prefix);

    return agent && upstreamId && !upstreamId.includes("/") ? { agent, upstreamId } : undefined;
}

export type SessionRouteResult = { route: ResolvedRoute } | { refusal: string };

/**
 * A session's route by model name: `codex/<id>[:effort]` to the record's Codex account, a bare `claude-*` id to its
 * Claude account, `grok/<id>` to its Grok account. Undefined for an id that is not a session form. The account
 * check that follows (`sessionRouteDenial`) still applies to every route.
 *
 * The account is the configured proxy account the record names (the legacy Codex account that reads
 * ~/.codex/auth.json among them), else an account built in memory for the record's login (❓ DECISION 1 a, Martin
 * 2026-10-25): never written to `ai-proxy/config.json`, and with no failover list. The server turns failover off on
 * every route a session takes, this form or a full account id (`sessionPinnedRoute`).
 */
export function resolveSessionRoute(
    proxyModelId: string,
    record: AiProxySessionRecord,
    accounts: AiProxyAccountConfig[]
): SessionRouteResult | undefined {
    const { modelId, reasoningEffort } = splitReasoningEffortSuffix(proxyModelId.trim());
    const form = sessionModelAgent(modelId);

    if (!form) {
        return undefined;
    }

    const name = record[SESSION_ACCOUNT_FIELD[form.agent]];
    const login = record[SESSION_LOGIN_FIELD[form.agent]];

    if (!name && !login) {
        return { refusal: `session ${record.id} has no ${form.agent} account, so it cannot run '${proxyModelId}'` };
    }

    const account = name ? accounts.find((item) => item.name === name) : loginAccount(form.agent, login ?? "");

    if (!account?.enabled) {
        return {
            refusal: `the ${form.agent} account "${name}" of session ${record.id} is ${account ? "disabled" : "not in the ai-proxy config"}`,
        };
    }

    if (agentOf(account.provider) !== form.agent) {
        return {
            refusal: `the ${form.agent} account "${name}" of session ${record.id} is a ${account.provider} account`,
        };
    }

    return {
        route: {
            accountName: account.name,
            providerSlug: account.providerSlug,
            upstreamId: form.upstreamId,
            account,
            ...(reasoningEffort ? { reasoningEffort, effortSource: "suffix" as const } : {}),
        },
    };
}

/**
 * A session's route, of any form, never moves to another login: a configured account with `failover` on comes back as a
 * copy with it off, because its failover logins are not in the record and the session check authorizes only the
 * account it names. The copy gets its own provider (`providerKeySuffix`), so it does not rebuild the account's normal
 * provider for other clients.
 */
export function sessionPinnedRoute(route: ResolvedRoute): ResolvedRoute {
    return route.account.failover
        ? { ...route, account: { ...route.account, failover: false }, providerKeySuffix: "#session" }
        : route;
}

/** The account the proxy builds for a login: the same shape a configured subscription account of that agent has. */
export function loginAccount(agent: SessionAgent, login: string): AiProxyAccountConfig {
    const provider = loginProviderFor(agent);

    return provider.login.bind(
        {
            name: loginAccountName(login),
            enabled: true,
            provider: provider.type,
            providerSlug: provider.definition.defaultSlug,
        },
        login
    );
}
