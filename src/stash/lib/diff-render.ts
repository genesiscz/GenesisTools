import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";

function formatDiffOutput(diffOutput: string, oldLabel: string, newLabel: string): string {
    const lines = diffOutput.split("\n");
    let formatted = "\n";

    for (const line of lines) {
        if (line.startsWith("---")) {
            formatted += chalk.red(`--- ${oldLabel}\n`);
        } else if (line.startsWith("+++")) {
            formatted += chalk.green(`+++ ${newLabel}\n`);
        } else if (line.startsWith("-")) {
            formatted += `${chalk.red(line)}\n`;
        } else if (line.startsWith("+")) {
            formatted += `${chalk.green(line)}\n`;
        } else if (line.startsWith("@")) {
            formatted += `${chalk.cyan(line)}\n`;
        } else {
            formatted += `${line}\n`;
        }
    }

    return formatted;
}

function fallbackLineDiff(args: { before: string; after: string; label: string }): string {
    const beforeLines = args.before.split("\n");
    const afterLines = args.after.split("\n");
    const lines = [`--- stored (${args.label})`, `+++ current`];
    const max = Math.max(beforeLines.length, afterLines.length);
    for (let i = 0; i < max; i++) {
        const b = beforeLines[i];
        const a = afterLines[i];
        if (b === a) {
            lines.push(`  ${b ?? ""}`);
        } else {
            if (b !== undefined) {
                lines.push(`- ${b}`);
            }
            if (a !== undefined) {
                lines.push(`+ ${a}`);
            }
        }
    }
    return lines.join("\n");
}

export function renderDiff(args: { before: string; after: string; label: string }): string {
    const oldLabel = `stored:${args.label}`;
    const newLabel = `current:${args.label}`;

    if (args.before === args.after) {
        return chalk.gray("No differences found.\n");
    }

    const dir = mkdtempSync(join(tmpdir(), "stash-diff-"));
    const oldFile = join(dir, "old");
    const newFile = join(dir, "new");
    try {
        writeFileSync(oldFile, args.before, "utf-8");
        writeFileSync(newFile, args.after, "utf-8");
        const result = spawnSync("diff", ["-U", "3", oldFile, newFile], { encoding: "utf-8" });
        if (result.status === 0) {
            return chalk.gray("No differences found.\n");
        }
        if (result.status === 1 && result.stdout) {
            return formatDiffOutput(result.stdout, oldLabel, newLabel);
        }
        return fallbackLineDiff(args);
    } catch {
        return fallbackLineDiff(args);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
