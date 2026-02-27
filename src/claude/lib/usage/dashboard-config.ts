import { Storage } from "@app/utils/storage/storage";

export interface UsageDashboardConfig {
    refreshInterval: number;
    prominentBuckets: string[];
    hiddenBuckets: string[];
    hiddenAccounts: string[];
    defaultTab: number;
    defaultTimelineZoom: string;
    historyLayout: "stacked" | "side-by-side";
    notifications: {
        enabled: boolean;
        inTui: boolean;
        macos: boolean;
        sound: string;
        thresholds: {
            session: number[];
            weekly: number[];
        };
    };
    dataRetentionDays: number;
}

const DEFAULTS: UsageDashboardConfig = {
    refreshInterval: 15,
    prominentBuckets: ["five_hour", "seven_day"],
    hiddenBuckets: [],
    hiddenAccounts: [],
    defaultTab: 0,
    defaultTimelineZoom: "30m",
    historyLayout: "stacked",
    notifications: {
        enabled: true,
        inTui: true,
        macos: true,
        sound: "Purr",
        thresholds: {
            session: [80],
            weekly: [20, 40, 60, 80],
        },
    },
    dataRetentionDays: 30,
};

const storage = new Storage("claude-usage-dashboard");

export async function loadDashboardConfig(): Promise<UsageDashboardConfig> {
    const saved = await storage.getConfig<Partial<UsageDashboardConfig>>();
    if (!saved) {
        return { ...DEFAULTS };
    }

    return {
        ...DEFAULTS,
        ...saved,
        notifications: {
            ...DEFAULTS.notifications,
            ...saved.notifications,
            thresholds: {
                ...DEFAULTS.notifications.thresholds,
                ...saved.notifications?.thresholds,
            },
        },
    };
}

export async function saveDashboardConfig(config: UsageDashboardConfig): Promise<void> {
    await storage.setConfig(config);
}
