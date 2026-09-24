// shellRules — the registry of shell pitfalls that produce confidently wrong
// answers, each harvested from ~/.claude/CLAUDE.md where it exists because it
// already produced one in a real session.
//
// A rule is one entry in SHELL_RULES: a stable id, the severity the corpus
// justified, the causal `why`, a wrong/right pair, the evidence, and a detector
// over a pre-computed ShellScan. detectShellViolations() runs the registry and
// returns an array of self-explaining violations, blocks first, then by index,
// so a reader never has to open CLAUDE.md to know what to write instead.
//
// The array is the API. `renderViolations` below shapes it for a harness; a
// lint command or a test can consume it directly. Nothing here rewrites a command:
// `suggestion` is the caller's command corrected, offered, never applied.

import { type ShellScan, scanShell } from "../scan";
import { destructiveRules } from "./destructive";
import { devnullRules } from "./devnull";
import { findRules } from "./find";
import { gitRules } from "./git";
import { pipelineRules } from "./pipeline";
import { rgRules } from "./rg";
import type { ShellMatch, ShellRule, ShellSeverity, ShellViolation } from "./types";
import { zshRules } from "./zsh";

export type { ShellMatch, ShellRule, ShellRuleKind, ShellScan, ShellSeverity, ShellViolation } from "./types";

const SEVERITY_RANK: Record<ShellSeverity, number> = { block: 0, warn: 1, context: 2 };

export const SHELL_RULES: readonly ShellRule[] = [
    ...pipelineRules,
    ...devnullRules,
    ...rgRules,
    ...findRules,
    ...gitRules,
    ...zshRules,
    ...destructiveRules,
];

export function ruleById(id: string): ShellRule | undefined {
    return SHELL_RULES.find((rule) => rule.id === id);
}

// Run every rule over one command. Never throws: a rule that crashes is
// skipped, because a guard that takes the harness down guards nothing.
export function detectShellViolations(command: string, rules: readonly ShellRule[] = SHELL_RULES): ShellViolation[] {
    let scan: ShellScan;

    try {
        scan = scanShell(command);
    } catch {
        return [];
    }

    const violations: ShellViolation[] = [];

    for (const rule of rules) {
        let match: ShellMatch | null;

        try {
            match = rule.detect(scan);
        } catch {
            continue;
        }

        if (!match) {
            continue;
        }

        violations.push({
            ruleId: rule.id,
            kind: rule.kind,
            severity: rule.severity,
            title: rule.title,
            why: rule.why,
            wrong: rule.wrong,
            right: rule.right,
            ...(rule.evidence ? { evidence: rule.evidence } : {}),
            matched: match.matched,
            index: match.index,
            ...(match.suggestion !== undefined ? { suggestion: match.suggestion } : {}),
        });
    }

    return violations.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.index - b.index);
}

// One violation as the model reads it: what, where, why, and what to write.
// Nothing is clipped: the corrected command is meant to be copied back
// verbatim, and a cut one cannot be (Martin, 2026-09-16: "include ALL input /
// output without slicing").
export function renderViolation(violation: ShellViolation): string {
    const lines = [
        `[${violation.severity}] ${violation.title} (rule ${violation.ruleId})`,
        `  matched (offset ${violation.index}): ${violation.matched}`,
        `  why: ${violation.why}`,
        `  wrong: ${violation.wrong}`,
        `  right: ${violation.right}`,
    ];

    if (violation.suggestion !== undefined) {
        lines.push(`  your command, corrected:\n${violation.suggestion}`);
    }

    return lines.join("\n");
}

export function renderViolations(violations: readonly ShellViolation[], heading: string): string {
    if (violations.length === 0) {
        return "";
    }

    return `${heading}\n${violations.map(renderViolation).join("\n")}`;
}
