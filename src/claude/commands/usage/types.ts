import type { AccountUsage } from "@app/claude/lib/usage/api";
import type { TabDefinition } from "@genesiscz/utils/ink/usage-dashboard/types";

export type TabId = "overview" | "history" | "sessions";

export type { TabDefinition };

export const TABS: TabDefinition[] = [
    { id: "overview", label: "Overview", shortcut: "1" },
    { id: "history", label: "History", shortcut: "2" },
    { id: "sessions", label: "Sessions", shortcut: "3" },
];

export interface PollResult {
    accounts: AccountUsage[];
    timestamp: Date;
    error?: string;
}
