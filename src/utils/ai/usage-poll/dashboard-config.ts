import {
    DEFAULT_ALERTS_CONFIG,
    mergeAlertsConfig,
    type StoredAlertsConfig,
    type UsageAlertsConfig,
} from "@genesiscz/utils/ai/usage/alerts/config";
import { EMPTY_BUDGETS, mergeBudgets, type UsageBudgets } from "@genesiscz/utils/ai/usage/budgets/budgets";
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
    /**
     * The banner and the in-TUI list. `macos` and `sound` also govern the alert engine's macOS channel. The threshold
     * lists that used to live here (`notifications.thresholds`) moved to `alerts.rules.threshold`.
     */
    notifications: {
        enabled: boolean;
        inTui: boolean;
        macos: boolean;
        sound: string;
    };
    /** The alert engine's settings (design 2026-11-01, step U7). */
    alerts: UsageAlertsConfig;
    /** Window and spend targets (proposal 18), nested by provider and immutable account id. */
    budgets: UsageBudgets;
    /** What only one provider has, keyed by plugin id: today the price of each plan (proposal 17). */
    providers: Record<string, UsageProviderSettings>;
    dataRetentionDays: number;
    /**
     * Whose history the "at pace" estimate is built from. `pooled` reads every
     * account's samples (your working rhythm, survives a fresh account);
     * `per-account` uses only the account in question.
     */
    paceScope: UsagePaceScope;
}

/** The price of one subscription plan, which no data source knows (proposal 17). */
export interface PlanPrice {
    /** In the currency's minor unit (cents). */
    priceMinor: number;
    currency: string;
}

export interface UsageProviderSettings {
    /** Keyed by the plan name the provider reports (`max`, `pro`). */
    plans?: Record<string, PlanPrice>;
}

/**
 * The pre-2026-11 `notifications` block, which still carried the threshold lists. A config written by an older build
 * keeps this shape until `migrateDashboardConfig` has run on it.
 */
interface StoredNotifications extends Partial<UsageDashboardConfig["notifications"]> {
    /** @deprecated Moved to `alerts.rules.threshold`; read only by the migration. */
    thresholds?: { session?: number[]; weekly?: number[] };
}

/** Same shape as `UsageDashboardConfig` but accepting the pre-2026-09 flat arrays and the pre-2026-11 thresholds. */
export type StoredConfig = Omit<
    Partial<UsageDashboardConfig>,
    "prominentBuckets" | "hiddenBuckets" | "notifications" | "alerts" | "budgets"
> & {
    budgets?: Partial<UsageBudgets>;
    prominentBuckets?: PerProviderKeys | string[];
    hiddenBuckets?: PerProviderKeys | string[];
    notifications?: StoredNotifications;
    alerts?: StoredAlertsConfig;
};

export const DEFAULT_PROMINENT_LIMITS: PerProviderKeys = {
    "anthropic-sub": ["five_hour", "seven_day", "seven_day_sonnet"],
    "openai-sub": ["primary", "secondary"],
    "grok-sub": ["weekly"],
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
    },
    alerts: DEFAULT_ALERTS_CONFIG,
    budgets: EMPTY_BUDGETS,
    providers: {},
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

/**
 * Every returned config is detached from `DEFAULTS`. The spreads below are shallow, so
 * without the clone a caller that pushed onto `hiddenAccounts` or edited a threshold list
 * would be editing the module constant, and every later load in the process would see it.
 */
function merge(stored: StoredConfig): UsageDashboardConfig {
    // Readers accept the old shape: a config the loader has not rewritten yet is migrated in memory first.
    const { config: saved } = migrateDashboardConfig(stored);
    const { thresholds: _moved, ...notifications } = saved.notifications ?? {};

    return structuredClone({
        ...DEFAULTS,
        ...saved,
        prominentBuckets: toPerProvider(saved.prominentBuckets, DEFAULTS.prominentBuckets),
        hiddenBuckets: toPerProvider(saved.hiddenBuckets, DEFAULTS.hiddenBuckets),
        notifications: { ...DEFAULTS.notifications, ...notifications },
        alerts: mergeAlertsConfig(saved.alerts),
        budgets: mergeBudgets(saved.budgets),
        providers: saved.providers ?? {},
    });
}

/**
 * Moves `notifications.thresholds` to `alerts.rules.threshold` (design 2026-11-01, step U7). Pure and idempotent:
 * when both are present the new place wins and the old lists only fill a gap, and the old key is removed. `changed`
 * says whether there was anything to move, so the loader writes the file back once.
 */
export function migrateDashboardConfig(stored: StoredConfig): { config: StoredConfig; changed: boolean } {
    const old = stored.notifications?.thresholds;

    if (old === undefined) {
        return { config: stored, changed: false };
    }

    const { thresholds: _moved, ...notifications } = stored.notifications ?? {};
    const current = stored.alerts?.rules?.threshold;
    const threshold = {
        ...(old.session === undefined ? {} : { session: old.session }),
        ...(old.weekly === undefined ? {} : { weekly: old.weekly }),
        ...current,
    };

    return {
        config: {
            ...stored,
            notifications,
            alerts: { ...stored.alerts, rules: { ...stored.alerts?.rules, threshold } },
        },
        changed: true,
    };
}

/**
 * Read the dashboard preferences, copying the claude-only store once on first run
 * (spec section 7.4). The copy is one-way and one-time: once `ai-usage-dashboard` has a
 * config of its own, the old file is never read again, so editing preferences in the new
 * TUI cannot be undone by a stale claude-era file.
 */
export async function loadDashboardConfig(options: { readOnly?: boolean } = {}): Promise<UsageDashboardConfig> {
    const saved = await store().getConfig<StoredConfig>();

    if (saved) {
        await writeBackMigration(saved, options.readOnly === true);
        return merge(saved);
    }

    const legacy = await legacyStore().getConfig<StoredConfig>();

    if (!legacy) {
        return structuredClone(DEFAULTS);
    }

    const migrated = merge(legacy);

    if (!options.readOnly) {
        logger.debug({ from: LEGACY_TOOL_NAME, to: TOOL_NAME }, "[usage] copied dashboard preferences once");
        await store().setConfig(migrated);
    }

    return migrated;
}

/**
 * Writes a migrated config back once, through the store's atomic update, so the old keys leave the file. A
 * diagnostic (`readOnly`) reads the migrated shape in memory and never writes. A write that fails is logged; the
 * next load migrates in memory again.
 */
async function writeBackMigration(saved: StoredConfig, readOnly: boolean): Promise<void> {
    if (readOnly || !migrateDashboardConfig(saved).changed) {
        return;
    }

    try {
        await store().atomicConfigUpdate<StoredConfig>((current) => {
            const { config } = migrateDashboardConfig(current);
            Object.assign(current, config);
        });
        logger.debug("[usage] moved notifications.thresholds to alerts.rules.threshold");
    } catch (err) {
        logger.warn({ err }, "[usage] the dashboard config migration could not be written back");
    }
}

export async function saveDashboardConfig(config: UsageDashboardConfig): Promise<void> {
    await store().setConfig(config);
}

/**
 * Edits the saved config under the store's lock (a budget set from the CLI); keys the edit does not touch stay. On a
 * Mac that never saved the new config, the edit starts from the claude-era preferences, as the first load would: an
 * edit that started from nothing would create the file without them, and the one-time copy never runs again.
 */
export async function updateDashboardConfig(edit: (stored: StoredConfig) => void): Promise<void> {
    const legacy = await legacyStore().getConfig<StoredConfig>();

    await store().atomicConfigUpdate<StoredConfig>((current) => {
        if (Object.keys(current).length === 0 && legacy) {
            Object.assign(current, merge(legacy));
        }

        edit(current);
    });
}

/** Windows shown by default for one provider, falling back to that provider's defaults. */
export function prominentFor(config: UsageDashboardConfig, provider: string): string[] {
    // Copied, not handed out: the fallback is a module constant and a caller that sorts
    // or splices the result would reorder the defaults for the rest of the process.
    return [...(config.prominentBuckets[provider] ?? DEFAULT_PROMINENT_LIMITS[provider] ?? [])];
}

export function hiddenFor(config: UsageDashboardConfig, provider: string): string[] {
    return [...(config.hiddenBuckets[provider] ?? [])];
}
