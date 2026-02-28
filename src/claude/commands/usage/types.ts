import type { AccountUsage } from "@app/claude/lib/usage/api";

export type TabId = "overview" | "timeline" | "rates" | "history";

export interface TabDefinition {
    id: TabId;
    label: string;
    shortcut: string;
}

export const TABS: TabDefinition[] = [
    { id: "overview", label: "Overview", shortcut: "1" },
    { id: "timeline", label: "Timeline", shortcut: "2" },
    { id: "rates", label: "Rates", shortcut: "3" },
    { id: "history", label: "History", shortcut: "4" },
];

export interface PollResult {
    accounts: AccountUsage[];
    timestamp: Date;
    error?: string;
}

export type TimelineZoom = "5m" | "15m" | "30m" | "1h" | "6h" | "24h" | "7d";

export const ZOOM_MINUTES: Record<TimelineZoom, number> = {
    "5m": 5,
    "15m": 15,
    "30m": 30,
    "1h": 60,
    "6h": 360,
    "24h": 1440,
    "7d": 10080,
};

export const ZOOM_ORDER: TimelineZoom[] = ["5m", "15m", "30m", "1h", "6h", "24h", "7d"];
