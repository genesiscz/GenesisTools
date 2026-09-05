import { claudeDriver } from "./claude";
import { codexDriver } from "./codex";
import { grokDriver } from "./grok";
import type { MonitorDriver } from "./types";

export { spendScopeRoots } from "./account-scope";
export { claudeDriver } from "./claude";
export { codexDriver } from "./codex";
export { grokDriver } from "./grok";
export type {
    AgentId,
    CreateParserOptions,
    DriverLineParser,
    DriverRoot,
    DriverUsageEvent,
    MonitorDriver,
} from "./types";
export { AGENT_IDS, AGENT_PLUGIN_IDS } from "./types";

/** Walk order is the report order. Claude first: it is the biggest tree. */
export const MONITOR_DRIVERS: readonly MonitorDriver[] = [claudeDriver, codexDriver, grokDriver];
