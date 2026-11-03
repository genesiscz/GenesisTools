import { ALERT_RULE_DEFAULTS } from "../config";
import { refireOnNewInstant } from "../refire";
import type { UsageAlertRule } from "../types";

/**
 * Proposal 3 as an alert: a window the provider stopped reporting (an account lost its 5-hour limit) or started
 * reporting again. Read from the stored availability, so each change fires once, at the row that recorded it.
 */
export const limitStateChangeRule: UsageAlertRule<"limit-state-change"> = {
    id: "limit-state-change",
    description: "A window disappeared (no limit any more) or came back",
    defaults: ALERT_RULE_DEFAULTS["limit-state-change"],
    evaluate(round) {
        return round.availabilityChanges.map((change) => {
            const gone = change.to === "absent";

            return {
                rule: "limit-state-change",
                provider: change.provider,
                accountId: change.accountId,
                accountName: change.accountName,
                windowKind: change.kind,
                windowKey: change.bucket,
                dedupeKey: `limit-state-change:${change.provider}:${change.accountName}:${change.bucket}`,
                cycle: change.at,
                severity: gone ? 1 : 0,
                level: "info",
                title: gone ? "A usage limit is gone" : "A usage limit is back",
                message: gone
                    ? `${change.accountName}: the ${change.bucket} window is no longer reported (no limit).`
                    : `${change.accountName}: the ${change.bucket} window is reported again.`,
                payload: { from: change.from, to: change.to, at: change.at },
            };
        });
    },
    refire: refireOnNewInstant,
};
