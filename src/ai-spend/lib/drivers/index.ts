import { claudeDriver } from "./claude";
import { codexDriver } from "./codex";
import { grokDriver } from "./grok";
import type { MonitorDriver } from "./types";

export { claudeDriver } from "./claude";
export { codexDriver } from "./codex";
export { grokDriver } from "./grok";
export type { AgentId, CreateParserOptions, DriverLineParser, DriverUsageEvent, MonitorDriver } from "./types";
export { AGENT_IDS } from "./types";

/** Walk order is the report order. Claude first: it is the biggest tree. */
export const MONITOR_DRIVERS: readonly MonitorDriver[] = [claudeDriver, codexDriver, grokDriver];
