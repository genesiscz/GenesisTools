import chalk from "chalk";
import { driftCount, type EnvDiff } from "./diff";
import { maskValue } from "./mask";

export interface RenderDiffArgs {
    diff: EnvDiff;
    actualLabel: string;
    exampleLabel: string;
    showValues: boolean;
    color: boolean;
}

export interface JsonShape {
    actual: string;
    example: string;
    missing: { key: string; exampleValue: string }[];
    extra: { key: string }[];
    changed: { key: string }[];
    inSyncCount: number;
    driftCount: number;
}

function shown(value: string, showValues: boolean): string {
    if (showValues) {
        return value;
    }

    return maskValue();
}

export function renderDiff({ diff, actualLabel, exampleLabel, showValues, color }: RenderDiffArgs): string {
    const c = {
        head: (s: string) => (color ? chalk.bold(s) : s),
        add: (s: string) => (color ? chalk.green(s) : s),
        del: (s: string) => (color ? chalk.red(s) : s),
        chg: (s: string) => (color ? chalk.yellow(s) : s),
        dim: (s: string) => (color ? chalk.dim(s) : s),
    };

    const total = driftCount(diff);
    const lines: string[] = [];
    lines.push(c.head(`envdiff  ${actualLabel}  vs  ${exampleLabel}`));

    if (total === 0) {
        lines.push(`  ${c.dim(`In sync (${diff.inSyncCount} keys) — no drift.`)}`);
        return lines.join("\n");
    }

    if (diff.missing.length > 0) {
        lines.push(c.head(`  Missing in ${actualLabel} (${diff.missing.length})`));
        for (const m of diff.missing) {
            lines.push(c.add(`    + ${m.key} = ${shown(m.exampleValue, showValues)}`) + c.dim("  (example value)"));
        }
    }

    if (diff.extra.length > 0) {
        lines.push(c.head(`  Extra in ${actualLabel} (${diff.extra.length})`));
        for (const e of diff.extra) {
            lines.push(c.del(`    - ${e.key}`));
        }
    }

    if (diff.changed.length > 0) {
        lines.push(c.head(`  Changed (${diff.changed.length})`));
        for (const ch of diff.changed) {
            const a = shown(ch.actualValue, showValues);
            const b = shown(ch.exampleValue, showValues);
            lines.push(c.chg(`    ~ ${ch.key}  ${a} ≠ ${b}`));
        }
    }

    lines.push(`  ${c.dim(`In sync (${diff.inSyncCount} keys)`)}`);
    lines.push("");
    lines.push(
        `Drift: ${total} differences.${diff.missing.length > 0 ? " Run `tools envdiff --sync` to add the missing keys." : ""}`
    );
    return lines.join("\n");
}

export function toJsonShape(diff: EnvDiff, labels: { actual: string; example: string }): JsonShape {
    return {
        actual: labels.actual,
        example: labels.example,
        missing: diff.missing.map((m) => ({ key: m.key, exampleValue: m.exampleValue })),
        extra: diff.extra.map((e) => ({ key: e.key })),
        changed: diff.changed.map((ch) => ({ key: ch.key })),
        inSyncCount: diff.inSyncCount,
        driftCount: driftCount(diff),
    };
}
