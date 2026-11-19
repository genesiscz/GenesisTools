/**
 * The harness names a task or a decision can be addressed to (a recipient), and their spellings. Shared by the
 * handoff tool, the decision log and the widget; moved here from `src/handoff/targeting.ts` (work-items P6).
 */
import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";
import { ACCOUNT_PROVIDER_ALIASES, isAccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { harnessDriver, harnessDrivers } from "@genesiscz/utils/ai/providers/harness-index";
import type { HarnessId } from "@genesiscz/utils/harness/types";

/** Documented recipient harness names: every harness, then Copilot, which is no harness but receives handoffs. */
export const HANDOFF_AGENTS: readonly HandoffAgent[] = [...ACCOUNT_PROVIDER_ALIASES, "copilot"];

export type HandoffAgent = HarnessId | "copilot";

export const HANDOFF_AGENTS_LIST = HANDOFF_AGENTS.join(", ");

/**
 * Spelling → canonical harness. The runtime context calls the Claude host
 * "claude-code" (AgentRuntimeContext.agent) while posters write "claude", so the
 * two must land on the same value or every claude session would read as a
 * mismatch against every claude-targeted handoff. Each harness's own spellings
 * come from its driver (id, binary, aliases, runtime agent name); the extra
 * entries are spellings posters wrote that no driver lists.
 */
const AGENT_ALIASES: ReadonlyMap<string, HandoffAgent> = new Map<string, HandoffAgent>([
    ...harnessDrivers().flatMap((driver) =>
        [driver.id, driver.identity.binary, harnessDriver(driver.id).parts.host.agent, ...driver.identity.aliases].map(
            (name): [string, HandoffAgent] => [name, driver.id]
        )
    ),
    ...["claudecode", "claude-cli"].map((name): [string, HandoffAgent] => [name, "claude"]),
    ["copilot", "copilot"],
    ["github-copilot", "copilot"],
]);

/** Canonical harness name, or null when the value names no documented harness. */
export function canonicalAgent(raw: string | null | undefined): HandoffAgent | null {
    if (typeof raw !== "string") {
        return null;
    }

    const key = raw.trim().toLowerCase();

    // A Map, so "constructor" or "__proto__" cannot read as a harness.
    return AGENT_ALIASES.get(key) ?? null;
}

/**
 * The runtime-context agent name of a recipient harness (`AgentRuntimeContext.agent`): each harness's host part names
 * its own (Claude is `claude-code`); Copilot keeps its name.
 */
export function runtimeAgentName(agent: HandoffAgent): AgentRuntimeContext["agent"] {
    return isAccountProviderAlias(agent) ? harnessDriver(agent).parts.host.agent : agent;
}

export function isKnownAgent(raw: string | null | undefined): boolean {
    return canonicalAgent(raw) !== null;
}
