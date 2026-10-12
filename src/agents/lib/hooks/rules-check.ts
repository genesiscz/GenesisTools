import { detectShellViolations } from "@genesiscz/utils/shell/rules";
import type { ShellRule } from "@genesiscz/utils/shell/rules/types";

/** One rule's own examples, run through that rule alone. */
export interface ExampleCheck {
    ruleId: string;
    /** The rules that fired on `wrong`; exactly this rule is a pass. */
    wrongGot: string[];
    /** The rules that fired on `right`; none is a pass. */
    rightGot: string[];
    ok: boolean;
}

/**
 * Every rule must fire on its own `wrong` example and stay quiet on its own `right` one. The
 * registry test holds the built-in rules to this; this holds a custom rule to it as well, since a
 * custom rule has no test suite of its own unless its author wrote one.
 */
export function checkRuleExamples(rules: readonly ShellRule[], options: { cwd?: string } = {}): ExampleCheck[] {
    return rules.map((rule) => {
        const wrongGot = detectShellViolations(rule.wrong, [rule], { cwd: options.cwd }).map((v) => v.ruleId);
        const rightGot = detectShellViolations(rule.right, [rule], { cwd: options.cwd }).map((v) => v.ruleId);

        return {
            ruleId: rule.id,
            wrongGot,
            rightGot,
            ok: wrongGot.length === 1 && wrongGot[0] === rule.id && rightGot.length === 0,
        };
    });
}

export interface CorpusRow {
    ruleId: string;
    /** Commands of the corpus this rule fired on. */
    fired: number;
    /** A few of them, first line only, cut to `sampleChars`. */
    samples: string[];
}

export interface CorpusReport {
    commands: number;
    rows: CorpusRow[];
}

function sampleOf(command: string, chars: number): string {
    const first = command.split("\n")[0] ?? "";
    const more = command.includes("\n") ? " …" : "";

    return first.length > chars ? `${first.slice(0, chars)}…` : `${first}${more}`;
}

/**
 * Replays recorded commands through the rules and counts, per rule, how many it would have fired
 * on. One scan per command, as the hook does it. A rule that fires on a large share of real
 * commands is either very valuable or too broad, and the samples say which.
 */
export function replayCorpus(
    commands: readonly string[],
    rules: readonly ShellRule[],
    options: { samples?: number; sampleChars?: number; cwd?: string } = {}
): CorpusReport {
    const samples = options.samples ?? 3;
    const sampleChars = options.sampleChars ?? 100;
    const rows = new Map<string, CorpusRow>(rules.map((rule) => [rule.id, { ruleId: rule.id, fired: 0, samples: [] }]));

    for (const command of commands) {
        const fired = new Set(detectShellViolations(command, rules, { cwd: options.cwd }).map((v) => v.ruleId));

        for (const ruleId of fired) {
            const row = rows.get(ruleId);

            if (!row) {
                continue;
            }

            row.fired += 1;

            if (row.samples.length < samples) {
                row.samples.push(sampleOf(command, sampleChars));
            }
        }
    }

    return { commands: commands.length, rows: [...rows.values()] };
}
