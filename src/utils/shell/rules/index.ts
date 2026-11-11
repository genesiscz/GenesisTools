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
import { biomeRules } from "./biome";
import { destructiveRules } from "./destructive";
import { devnullRules } from "./devnull";
import { correctedPart } from "./excerpt";
import { findRules } from "./find";
import { gitRules } from "./git";
import { pipelineRules } from "./pipeline";
import { rgRules } from "./rg";
import { swiftpmRules } from "./swiftpm";
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
    ...swiftpmRules,
    ...destructiveRules,
    ...biomeRules,
];

export function ruleById(id: string): ShellRule | undefined {
    return SHELL_RULES.find((rule) => rule.id === id);
}

// Run every rule over one command. Never throws: a rule that crashes is
// skipped, because a guard that takes the harness down guards nothing.
export function detectShellViolations(
    command: string,
    rules: readonly ShellRule[] = SHELL_RULES,
    options: { cwd?: string } = {}
): ShellViolation[] {
    let scan: ShellScan;

    try {
        scan = scanShell(command, options.cwd);
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
            ...(match.detail !== undefined ? { detail: match.detail } : {}),
        });
    }

    return violations.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.index - b.index);
}

export interface RenderOptions {
    /** The command the violations came from. A long corrected command is then cut to the part that changed. */
    command?: string;
    /** Rules this loop already read in full since its last compaction: they get the compact form. */
    explained?: ReadonlySet<string>;
    /** The command did not run: the compact form keeps the reason, so the message is enough to act on alone. */
    denied?: boolean;
}

/** The first sentence of a rule's `why`. A `$?` or `e.g.` inside it is no end, because no capital follows. */
export function firstSentence(text: string): string {
    return text.match(/^[\s\S]*?[.!?](?=\s+[A-Z]|\s*$)/)?.[0] ?? text;
}

// One violation as the model reads it: what, where, why, and what to write. The first time a loop meets a rule it
// reads `why`, `wrong` and `right`; later it reads the compact form (2026-11-11: the long text repeated on every
// firing). The corrected command is printed whole when it is short, else the part that changed, uncut, because
// that is the part to copy back (Martin, 2026-09-16: "include ALL input / output without slicing").
export function renderViolation(violation: ShellViolation, options: RenderOptions = {}): string {
    const compact = options.explained?.has(violation.ruleId) ?? false;
    const lines = [
        `[${violation.severity}] ${violation.title} (rule ${violation.ruleId})${compact ? " (explained earlier in this session)" : ""}`,
        `  matched (offset ${violation.index}): ${violation.matched}`,
        ...(violation.detail !== undefined ? [`  here: ${violation.detail}`] : []),
    ];

    if (!compact) {
        lines.push(`  why: ${violation.why}`, `  wrong: ${violation.wrong}`, `  right: ${violation.right}`);
    } else if (options.denied) {
        lines.push(`  why: ${firstSentence(violation.why)}`);

        if (violation.suggestion === undefined) {
            lines.push(`  right: ${violation.right}`);
        }
    }

    if (violation.suggestion !== undefined) {
        const part = correctedPart({
            command: options.command,
            suggestion: violation.suggestion,
            matched: { index: violation.index, length: violation.matched.length },
        });

        lines.push(
            part.whole
                ? `  your command, corrected:\n${part.text}`
                : `  corrected part (the rest stays as you wrote it):\n${part.text}`
        );
    }

    return lines.join("\n");
}

export function renderViolations(
    violations: readonly ShellViolation[],
    heading: string,
    options: RenderOptions = {}
): string {
    if (violations.length === 0) {
        return "";
    }

    return `${heading}\n${violations.map((violation) => renderViolation(violation, options)).join("\n")}`;
}
