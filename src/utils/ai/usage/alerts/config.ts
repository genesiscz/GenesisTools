import { logger } from "@genesiscz/utils/logger";
import { ALERT_CHANNEL_IDS, type AlertChannelId, type AlertRuleId, type AlertRuleSettings } from "./types";

/**
 * The `alerts` key of the usage dashboard config (`~/.genesis-tools/ai-usage-dashboard/config.json`), nested by axis:
 * what holds for every alert (`global`), each rule's settings (`rules.<rule>`), and per provider overrides
 * (`providers.<plugin id>.rules.<rule>.enabled`). Rules key on the window kind, so a provider appears here only when
 * the user turns a rule off for it.
 */
export interface UsageAlertsConfig {
    global: {
        enabled: boolean;
        /** Local `HH:MM` span in which an interrupting channel (a banner) is held; null for none. */
        quietHours: { start: string; end: string } | null;
    };
    rules: AlertRuleSettings;
    providers: Record<string, { rules?: Partial<Record<AlertRuleId, { enabled?: boolean }>> }>;
}

/** One rule's saved settings: any key may be missing, and a nested record (`leadMinutes`) key by key. */
export type StoredRuleSettings<S> = {
    [K in keyof S]?: S[K] extends readonly unknown[] ? S[K] : S[K] extends object ? Partial<S[K]> : S[K];
};

/** The saved form: any key may be missing, each rule's settings too. */
export interface StoredAlertsConfig {
    global?: Partial<UsageAlertsConfig["global"]>;
    rules?: { [Id in AlertRuleId]?: StoredRuleSettings<AlertRuleSettings[Id]> };
    providers?: UsageAlertsConfig["providers"];
}

/**
 * Each rule's defaults. The threshold lists are the values `notifications.thresholds` shipped with. A banner goes out
 * for the two rules that used to interrupt (threshold) or that ask for action now (predicted exhaust); the quieter
 * rules land in the widget inbox, and health alerts are only recorded, because a Mac that slept an hour would
 * otherwise post one every morning.
 */
export const ALERT_RULE_DEFAULTS: AlertRuleSettings = {
    threshold: { enabled: true, channels: ["macos"], session: [80], weekly: [20, 40, 60, 80] },
    "predicted-exhaust": {
        enabled: true,
        channels: ["macos", "inbox"],
        leadMinutes: { session: 45, weekly: 12 * 60, scoped: 6 * 60 },
        requireActive: true,
        activeMinutes: 30,
    },
    "limit-state-change": { enabled: true, channels: ["inbox"] },
    health: { enabled: true, channels: [], downMinutes: 10, refreshExpiryDays: 7 },
    "rate-limited": { enabled: true, channels: ["inbox"], count: 3, windowMinutes: 10 },
};

export const DEFAULT_ALERTS_CONFIG: UsageAlertsConfig = {
    global: { enabled: true, quietHours: null },
    rules: ALERT_RULE_DEFAULTS,
    providers: {},
};

function mergeRule<Id extends AlertRuleId>(
    id: Id,
    saved: StoredRuleSettings<AlertRuleSettings[Id]> | undefined
): AlertRuleSettings[Id] {
    const merged = { ...ALERT_RULE_DEFAULTS[id], ...saved };
    // A hand-edited channel id the engine has no channel for would throw in delivery (in quiet hours, out of the
    // round): it is dropped here, the one door every saved rule passes.
    const channels = merged.channels.filter((channel) => (ALERT_CHANNEL_IDS as readonly string[]).includes(channel));

    if (channels.length !== merged.channels.length) {
        logger.warn({ rule: id, channels: merged.channels }, "[usage-alerts] unknown channel ids dropped");
    }

    return { ...merged, channels };
}

/** The saved alerts config over the defaults, detached from both. */
export function mergeAlertsConfig(saved: StoredAlertsConfig | undefined): UsageAlertsConfig {
    const rules = saved?.rules;

    return structuredClone({
        global: { ...DEFAULT_ALERTS_CONFIG.global, ...saved?.global },
        rules: {
            threshold: mergeRule("threshold", rules?.threshold),
            "predicted-exhaust": {
                ...mergeRule("predicted-exhaust", rules?.["predicted-exhaust"]),
                leadMinutes: {
                    ...ALERT_RULE_DEFAULTS["predicted-exhaust"].leadMinutes,
                    ...rules?.["predicted-exhaust"]?.leadMinutes,
                },
            },
            "limit-state-change": mergeRule("limit-state-change", rules?.["limit-state-change"]),
            health: mergeRule("health", rules?.health),
            "rate-limited": mergeRule("rate-limited", rules?.["rate-limited"]),
        },
        providers: saved?.providers ?? {},
    });
}

/** A rule is on for a provider unless the rule is off, or that provider turns it off. */
export function ruleEnabledFor(config: UsageAlertsConfig, rule: AlertRuleId, provider: string | null): boolean {
    if (!config.global.enabled || !config.rules[rule].enabled) {
        return false;
    }

    return provider === null || config.providers[provider]?.rules?.[rule]?.enabled !== false;
}

function minutesOf(clock: string): number | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());

    if (!match) {
        return null;
    }

    return Number(match[1]) * 60 + Number(match[2]);
}

/** Whether `now` falls in the quiet hours, read in the local zone; a span over midnight wraps. */
export function inQuietHours(quiet: UsageAlertsConfig["global"]["quietHours"], now: Date): boolean {
    if (!quiet) {
        return false;
    }

    const start = minutesOf(quiet.start);
    const end = minutesOf(quiet.end);

    if (start === null || end === null || start === end) {
        return false;
    }

    const minute = now.getHours() * 60 + now.getMinutes();
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** The channels an alert of `rule` goes to now: the rule's list, minus the interrupting ones in quiet hours. */
export function deliveryChannels(input: {
    config: UsageAlertsConfig;
    rule: AlertRuleId;
    now: Date;
    interrupts: (channel: AlertChannelId) => boolean;
}): AlertChannelId[] {
    const quiet = inQuietHours(input.config.global.quietHours, input.now);
    return input.config.rules[input.rule].channels.filter((channel) => !(quiet && input.interrupts(channel)));
}
