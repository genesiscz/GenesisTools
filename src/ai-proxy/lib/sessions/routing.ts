import { splitReasoningEffortSuffix } from "@app/ai-proxy/lib/resolve-model";
import type { AiProxySessionRecord } from "@app/ai-proxy/lib/sessions/records";
import { agentOf, type ProxyAgent } from "@app/ai-proxy/lib/sessions/view";
import type { AiProxyAccountConfig, ResolvedRoute } from "@app/ai-proxy/lib/types";

export type SessionAgent = Exclude<ProxyAgent, "other">;

/** The agents a session names by a prefix (`codex/<id>`, `grok/<id>`); a Claude model is named by its bare id. */
const PREFIXED_AGENTS: readonly SessionAgent[] = ["codex", "grok"];

const ACCOUNT_FIELD = {
    codex: "codexProxyAccount",
    claude: "claudeProxyAccount",
    grok: "grokProxyAccount",
} as const satisfies Record<SessionAgent, keyof AiProxySessionRecord>;

/** Claude Code strips its `[1m]` window suffix before it sends a request; another client may not. */
const ONE_M_SUFFIX = /\[1m\]$/i;

/**
 * The agent a short model id names inside a session: `codex/<id>` and `grok/<id>` by their prefix, a bare
 * `claude-*` id by its name (P5). Every other id (a full `account/provider/model`, an `@account/…` ref) is not a
 * session form and resolves as for any client.
 */
export function sessionModelAgent(modelId: string): { agent: SessionAgent; upstreamId: string } | undefined {
    const slash = modelId.indexOf("/");

    if (slash === -1) {
        return /^claude-/i.test(modelId)
            ? { agent: "claude", upstreamId: modelId.replace(ONE_M_SUFFIX, "") }
            : undefined;
    }

    const prefix = modelId.slice(0, slash);
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
 * The record names proxy accounts (`ai-proxy/config.json`); ❓ DECISION 1 may add accounts built from a login.
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

    const name = record[ACCOUNT_FIELD[form.agent]];

    if (!name) {
        return { refusal: `session ${record.id} has no ${form.agent} account, so it cannot run '${proxyModelId}'` };
    }

    const account = accounts.find((item) => item.name === name);

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
