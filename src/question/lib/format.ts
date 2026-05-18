import chalk from "chalk";
import type { QaEntry } from "./types";

// chalk auto-detects stdout: full color on a TTY, no-ops when piped/redirected,
// so digests are colorful in a terminal and clean ANSI-free for `| tools json`.
const TAG_TINT: Record<string, (s: string) => string> = {
    question: chalk.bold.blue,
    action: chalk.bold.yellow,
    directive: chalk.bold.green,
};

type FormattableEntry = Pick<QaEntry, "ts" | "project" | "branch" | "tag" | "question" | "answerMd">;

/**
 * Single source of truth for one Q→A entry's terminal rendering. Used by both
 * `tools question log` (newest-first digest) and `tools question tail` (live
 * feed) so they are visually identical per entry.
 */
export function formatQaEntry(e: FormattableEntry): string {
    const when = new Date(e.ts).toISOString().slice(0, 16).replace("T", " ");
    const tint = TAG_TINT[e.tag] ?? chalk.bold.gray;
    const head = `${chalk.dim(when)}  ${chalk.cyan.bold(e.project)} ${chalk.dim("·")} ${chalk.magenta(e.branch ?? "-")}  ${tint(`[${e.tag}]`)}`;
    const preview = chalk.yellow(e.answerMd.split("\n").slice(0, 3).join("\n"));
    return `${head}\n${chalk.green("❯")} ${chalk.bold(e.question)}\n${preview}\n`;
}
