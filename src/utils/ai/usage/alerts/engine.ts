import { logger } from "@genesiscz/utils/logger";
import { deliveryChannels, ruleEnabledFor, type UsageAlertsConfig } from "./config";
import type { UsageAlertsStore } from "./log";
import { ALERT_RULES } from "./rules";
import {
    ALERT_RULE_IDS,
    type AlertCandidate,
    type AlertChannelTable,
    type AlertRound,
    type AlertRuleId,
    type AlertRuleTable,
    type StoredAlert,
} from "./types";

/** A candidate with the engine's verdict, for `tools ai usage alerts test`. */
export interface JudgedCandidate {
    candidate: AlertCandidate;
    /** Whether the engine would fire it now. */
    fires: boolean;
    /** The alert it repeats, when one with the same dedupe key exists. */
    previous: StoredAlert | null;
}

function evaluateRule<Id extends AlertRuleId>(
    rules: AlertRuleTable,
    id: Id,
    round: AlertRound,
    config: UsageAlertsConfig
): AlertCandidate[] {
    const rule: AlertRuleTable[Id] = rules[id];

    try {
        return rule
            .evaluate(round, config.rules[id])
            .filter((candidate) => ruleEnabledFor(config, id, candidate.provider));
    } catch (err) {
        logger.warn({ err, rule: id }, "[usage-alerts] a rule failed; the others still run");
        return [];
    }
}

/**
 * Every candidate of the enabled rules with the engine's dedupe verdict, and nothing written. The engine's firing
 * path and the `alerts test` diagnostic share it, so the test answers exactly what the daemon would do.
 */
export function judgeRound(input: {
    round: AlertRound;
    config: UsageAlertsConfig;
    store: Pick<UsageAlertsStore, "latestByDedupe">;
    only?: readonly AlertRuleId[];
    rules?: AlertRuleTable;
}): JudgedCandidate[] {
    const rules = input.rules ?? ALERT_RULES;
    const judged: JudgedCandidate[] = [];

    for (const id of input.only ?? ALERT_RULE_IDS) {
        if (!input.config.global.enabled || !input.config.rules[id].enabled) {
            continue;
        }

        for (const candidate of evaluateRule(rules, id, input.round, input.config)) {
            const previous = input.store.latestByDedupe(candidate.dedupeKey);
            const fires = previous === null || rules[id].refire(previous, candidate, input.round.now);
            judged.push({ candidate, fires, previous });
        }
    }

    return judged;
}

/**
 * One tick of the alert engine (design 2026-11-01, step U7): judge the round, record each alert that fires in
 * `usage_alerts`, then deliver it to its rule's channels (minus the interrupting ones in quiet hours). The record is
 * written before delivery, so a channel that fails never makes the next tick fire the same alert again. Each record
 * is a claim: the dedupe verdict is judged again inside the insert's transaction, so a process that recorded the key
 * after this round was judged (the daemon and the usage TUI share the database) wins, and this one delivers nothing.
 */
export async function runAlertEngine(input: {
    round: AlertRound;
    config: UsageAlertsConfig;
    store: UsageAlertsStore;
    channels: AlertChannelTable;
    rules?: AlertRuleTable;
    /** Only these rules; omitted runs every rule. The usage TUI runs `threshold` alone. */
    only?: readonly AlertRuleId[];
}): Promise<StoredAlert[]> {
    const fired: StoredAlert[] = [];
    const rules = input.rules ?? ALERT_RULES;

    for (const { candidate, fires } of judgeRound(input)) {
        if (!fires) {
            continue;
        }

        const channels = deliveryChannels({
            config: input.config,
            rule: candidate.rule,
            now: input.round.now,
            interrupts: (channel) => input.channels[channel].interrupts,
        });
        const alert = input.store.claim(
            candidate,
            { firedAt: input.round.now, channels },
            (previous) => previous === null || rules[candidate.rule].refire(previous, candidate, input.round.now)
        );

        if (!alert) {
            logger.debug({ rule: candidate.rule, dedupeKey: candidate.dedupeKey }, "[usage-alerts] already claimed");
            continue;
        }

        fired.push(alert);

        for (const channel of channels) {
            try {
                await input.channels[channel].deliver(alert);
            } catch (err) {
                logger.warn({ err, channel, rule: alert.rule, id: alert.id }, "[usage-alerts] delivery failed");
            }
        }
    }

    if (fired.length > 0) {
        logger.info(
            { fired: fired.map((alert) => ({ id: alert.id, rule: alert.rule, account: alert.accountName })) },
            "[usage-alerts] alerts fired"
        );
    }

    return fired;
}
