import { dirname } from "node:path";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { tryProviderPlugin } from "@genesiscz/utils/ai/providers/registry";
import { logger } from "@genesiscz/utils/logger";
import { AGENT_PLUGIN_IDS, type AgentId, type DriverRoot } from "./types";

/**
 * The one place a driver asks a provider plugin where an account's transcripts
 * live. Every `MonitorDriver.rootsForAccounts` is this function plus its agent
 * id, so the three implementations cannot drift apart.
 *
 * `tryProviderPlugin`, not `providerPlugin`: the drivers are imported by the
 * ccusage reports and by tests that never call `registerBuiltInPlugins()`.
 * A missing plugin means "no account attribution available", which is exactly
 * today's unbound behaviour — not a crash in a reporting command.
 */
export interface SpendScopeRootsOptions {
    agent: AgentId;
    accounts: readonly AccountEntry[];
    /**
     * The provider's accounts all share ONE tree (anthropic, decision D6). It is
     * emitted once and left untagged, because emitting it per account would bill
     * the same bytes to every login.
     */
    shared?: boolean;
    /**
     * Keep only roots this list already contains.
     *
     * A shared `spendScope` answers for the process's real `$HOME` — it has no
     * account-specific home to derive one from. The driver's own roots are the
     * boundary of the home the CALLER asked about, so intersecting them is what
     * stops an injected home from dragging the real `~/.claude/projects` in
     * beside it. In normal use the two lists are identical and nothing is cut.
     */
    within?: readonly string[];
}

export function spendScopeRoots(options: SpendScopeRootsOptions): DriverRoot[] {
    const pluginId = AGENT_PLUGIN_IDS[options.agent];
    const spendScope = tryProviderPlugin(pluginId)?.accounts?.spendScope;

    if (!spendScope) {
        logger.debug({ agent: options.agent, plugin: pluginId }, "ai-spend: no spendScope, roots stay unbound");

        return [];
    }

    const roots: DriverRoot[] = [];
    const seen = new Set<string>();
    const allowed = options.within ? new Set(options.within) : undefined;

    for (const account of options.accounts) {
        if (account.provider !== pluginId) {
            continue;
        }

        const scope = spendScope(account);

        if (!scope) {
            continue;
        }

        for (const path of scope.transcriptRoots) {
            if (seen.has(path) || (allowed && !allowed.has(path))) {
                continue;
            }

            seen.add(path);
            // The home is read back off the root (`<home>/sessions`) rather than
            // off the account, so a grok worker home reports itself and not the
            // login home whose credential it borrows.
            roots.push(options.shared ? { path } : { path, accountId: account.id, home: dirname(path) });
        }

        if (options.shared) {
            return roots;
        }
    }

    return roots;
}
