import { UNBOUND_ACCOUNT_ID } from "@genesiscz/utils/ai/usage";
import { hasMembers, toolParts } from "@genesiscz/utils/harness/tool-parts";
import { AGENT_IDS, type AgentId, type MonitorDriver } from "./types";

export { spendScopeRoots } from "./account-scope";
export { claudeDriver } from "./claude";
export { codexDriver } from "./codex";
export { grokDriver } from "./grok";
export type {
    AgentId,
    ByAgent,
    CreateParserOptions,
    DriverLineParser,
    DriverRoot,
    DriverUsageEvent,
    MonitorDriver,
} from "./types";
export { AGENT_IDS, agentPluginId } from "./types";

/**
 * The spend part of every harness: `drivers/<harness id>.ts` exports it as `spendPart` (`toolParts`), because a
 * MonitorDriver reads ai-spend's own parsers and pricing, which the harness drivers cannot import. A new harness adds
 * its module here and edits no table. Every other file reads a driver through `spendDriver` or `MONITOR_DRIVERS`.
 */
const SPEND_PARTS = toolParts<MonitorDriver>({
    meta: import.meta,
    folder: ".",
    exportName: "spendPart",
    isPart: hasMembers<MonitorDriver>("id", "roots"),
});

export function spendDriver(agent: AgentId): MonitorDriver {
    return SPEND_PARTS.of(agent);
}

/** Walk order is the report order: the canonical harness order, Claude first (it is the biggest tree). */
export const MONITOR_DRIVERS: readonly MonitorDriver[] = AGENT_IDS.map(spendDriver);

/**
 * Which account row a transcript's spend lands in: the agent's shared row, else the account that claims the
 * transcript's home, else the unbound row (spend on an unbound home is still spend, so it is never dropped).
 */
export function spendAccountRowId(agent: AgentId, fileAccountId: string | undefined): string {
    return spendDriver(agent).sharedAccountRow ?? fileAccountId ?? UNBOUND_ACCOUNT_ID;
}
