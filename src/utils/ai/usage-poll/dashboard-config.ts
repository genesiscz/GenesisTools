import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";

/** Whose history the "at pace" estimate is built from. Mirrors `PaceScope` in burn-pace.ts. */
export type UsagePaceScope = "pooled" | "per-account";

/** Window keys per plugin id. A legacy `string[]` is read as the anthropic list. */
export type PerProviderKeys = Record<string, string[]>;

export interface UsageDashboardConfig {
    refreshInterval: number;
    prominentBuckets: PerProviderKeys;
    hiddenBuckets: PerProviderKeys;
    hiddenAccounts: string[];
    defaultTab: number;
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
    /**
     * Whose history the "at pace" estimate is built from. `pooled` reads every
     * account's samples (your working rhythm, survives a fresh account);
     * `per-account` uses only the account in question.
     */
    paceScope: UsagePaceScope;
}

/** Same shape as `UsageDashboardConfig` but accepting the pre-2026-09 flat arrays. */
type StoredConfig = Omit<Partial<UsageDashboardConfig>, "prominentBuckets" | "hiddenBuckets"> & {
    prominentBuckets?: PerProviderKeys | string[];
    hiddenBuckets?: PerProviderKeys | string[];
};

export const DEFAULT_PROMINENT_LIMITS: PerProviderKeys = {
    "anthropic-sub": ["five_hour", "seven_day", "seven_day_sonnet"],
    "openai-sub": ["primary"],
    "grok-sub": ["monthly"],
};

const DEFAULTS: UsageDashboardConfig = {
    refreshInterval: 60,
    prominentBuckets: DEFAULT_PROMINENT_LIMITS,
    hiddenBuckets: {},
    hiddenAccounts: [],
    defaultTab: 0,
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
    paceScope: "pooled",
};

const LEGACY_TOOL_NAME = "claude-usage-dashboard";
const TOOL_NAME = "ai-usage-dashboard";

let storage: Storage | null = null;
let legacyStorage: Storage | null = null;

function store(): Storage {
    if (!storage) {
        storage = new Storage(TOOL_NAME);
    }

    return storage;
}

function legacyStore(): Storage {
    if (!legacyStorage) {
        legacyStorage = new Storage(LEGACY_TOOL_NAME);
    }

    return legacyStorage;
}

/** Reset the memoised stores. Tests move `GENESIS_TOOLS_HOME` between cases. */
export function __resetDashboardConfigStores(): void {
    storage = null;
    legacyStorage = null;
}

/** A flat `["five_hour", …]` from the claude-only config belongs to `anthropic-sub`. */
function toPerProvider(value: PerProviderKeys | string[] | undefined, fallback: PerProviderKeys): PerProviderKeys {
    if (!value) {
        return fallback;
    }

    if (Array.isArray(value)) {
        return { ...fallback, "anthropic-sub": value };
    }

    return { ...fallback, ...value };
}

function merge(saved: StoredConfig): UsageDashboardConfig {
    return {
        ...DEFAULTS,
        ...saved,
        prominentBuckets: toPerProvider(saved.prominentBuckets, DEFAULTS.prominentBuckets),
        hiddenBuckets: toPerProvider(saved.hiddenBuckets, DEFAULTS.hiddenBuckets),
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

/**
 * Read the dashboard preferences, copying the claude-only store once on first run
 * (spec section 7.4). The copy is one-way and one-time: once `ai-usage-dashboard` has a
 * config of its own, the old file is never read again, so editing preferences in the new
 * TUI cannot be undone by a stale claude-era file.
 */
export async function loadDashboardConfig(): Promise<UsageDashboardConfig> {
    const saved = await store().getConfig<StoredConfig>();

    if (saved) {
        return merge(saved);
    }

    const legacy = await legacyStore().getConfig<StoredConfig>();

    if (!legacy) {
        return { ...DEFAULTS };
    }

    const migrated = merge(legacy);
    logger.debug({ from: LEGACY_TOOL_NAME, to: TOOL_NAME }, "[usage] copied dashboard preferences once");
    await store().setConfig(migrated);

    return migrated;
}

export async function saveDashboardConfig(config: UsageDashboardConfig): Promise<void> {
    await store().setConfig(config);
}

/** Windows shown by default for one provider, falling back to that provider's defaults. */
export function prominentFor(config: UsageDashboardConfig, provider: string): string[] {
    return config.prominentBuckets[provider] ?? DEFAULT_PROMINENT_LIMITS[provider] ?? [];
}

export function hiddenFor(config: UsageDashboardConfig, provider: string): string[] {
    return config.hiddenBuckets[provider] ?? [];
}
