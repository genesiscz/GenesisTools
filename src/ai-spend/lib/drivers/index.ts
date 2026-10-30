import { UNBOUND_ACCOUNT_ID } from "@genesiscz/utils/ai/usage";
import { claudeDriver } from "./claude";
import { codexDriver } from "./codex";
import { grokDriver } from "./grok";
import { AGENT_IDS, type AgentId, type ByAgent, type MonitorDriver } from "./types";

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
 * The spend part of every harness, and the one table of it in ai-spend: each harness driver's `spend` note names
 * this module (`toolOwned`), because MonitorDriver reads ai-spend's own parsers and pricing. Every other file reads
 * a driver through `spendDriver` or `MONITOR_DRIVERS`, never by a name of its own.
 */
const SPEND_DRIVERS: Readonly<ByAgent<MonitorDriver>> = { claude: claudeDriver, codex: codexDriver, grok: grokDriver };

export function spendDriver(agent: AgentId): MonitorDriver {
    return SPEND_DRIVERS[agent];
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
