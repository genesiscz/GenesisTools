import type { ShellScan } from "../scan";

export type { ShellScan };

/**
 * `block`: the call is denied. `context`: the call runs and the violation is injected as
 * additional context for the model. `warn`: the call runs and the user sees an advisory.
 * Per-harness and per-model config may move a rule between these; the rule's own severity
 * is the default.
 */
export type ShellSeverity = "block" | "context" | "warn";

/**
 * `misread`: the OUTPUT lies (an empty count, tail's exit code), and a long command
 * that trips it is cheaper to warn about than to re-run. `destructive`: work or data
 * is gone, so command length never buys a pass.
 */
export type ShellRuleKind = "misread" | "destructive";

export interface ShellMatch {
    /** The exact substring of the original command that tripped the rule. */
    matched: string;
    /** Offset of `matched` in the original command. */
    index: number;
    /** The caller's command, corrected, when that is safely derivable. */
    suggestion?: string;
}

export interface ShellRule {
    /** Stable, kebab-case. Config keys and log fields use it. */
    id: string;
    kind: ShellRuleKind;
    /** One line: what the rule catches. */
    title: string;
    severity: ShellSeverity;
    /** WHY the shape yields a wrong answer, causally. */
    why: string;
    /** A concrete wrong command. */
    wrong: string;
    /** The corrected form of that same command. */
    right: string;
    /** The incident behind the rule and the corpus count that set its severity. */
    evidence?: string;
    detect(scan: ShellScan): ShellMatch | null;
}

export interface ShellViolation extends ShellMatch {
    ruleId: string;
    kind: ShellRuleKind;
    severity: ShellSeverity;
    title: string;
    why: string;
    wrong: string;
    right: string;
    evidence?: string;
}
