import type { AlertRuleTable } from "../types";
import { healthRule } from "./health";
import { limitStateChangeRule } from "./limit-state-change";
import { predictedExhaustRule } from "./predicted-exhaust";
import { rateLimitedRule } from "./rate-limited";
import { thresholdRule } from "./threshold";

/**
 * Every alert rule, keyed by its id. The key type is `AlertRuleId`, so a rule without an entry is a compile error and
 * a new rule is its file plus one line here. The spike rule (proposal 4) and the budget rule (proposal 18) join with
 * build steps U9 and U10.
 */
export const ALERT_RULES = {
    threshold: thresholdRule,
    "predicted-exhaust": predictedExhaustRule,
    "limit-state-change": limitStateChangeRule,
    health: healthRule,
    "rate-limited": rateLimitedRule,
} satisfies AlertRuleTable;
