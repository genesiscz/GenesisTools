import pc from "picocolors";
import type { QaEntry } from "./types";

// picocolors (the codebase convention over chalk) auto-detects stdout: full
// color on a TTY, no-ops when piped/redirected — colorful in a terminal,
// clean ANSI-free for `| tools json`.
const TAG_TINT: Record<string, (s: string) => string> = {
    question: (s) => pc.bold(pc.blue(s)),
    action: (s) => pc.bold(pc.yellow(s)),
    directive: (s) => pc.bold(pc.green(s)),
};

type FormattableEntry = Pick<
    QaEntry,
    "ts" | "project" | "branch" | "tag" | "question" | "answerMd" | "sessionId"
>;

/**
 * Single source of truth for one Q→A entry's terminal rendering. Used by both
 * `tools question log` (newest-first digest) and `tools question tail` (live
 * feed) so they are visually identical per entry.
 */
export function formatQaEntry(e: FormattableEntry): string {
    const when = new Date(e.ts).toISOString().slice(0, 16).replace("T", " ");
    const tint = TAG_TINT[e.tag] ?? ((s: string) => pc.bold(pc.gray(s)));
    const head = `${pc.dim(when)}  ${pc.bold(pc.cyan(e.project))} ${pc.dim("·")} ${pc.magenta(e.branch ?? "-")}  ${tint(`[${e.tag}]`)}`;
    const preview = pc.yellow(e.answerMd.split("\n").slice(0, 3).join("\n"));
    const sid = e.sessionId && e.sessionId !== "unknown" ? e.sessionId.slice(0, 8) : null;
    const resume = sid ? pc.dim(`  ↩ ${sid} · tools claude resume ${sid}\n`) : "";
    return `${head}\n${pc.green("❯")} ${pc.bold(e.question)}\n${preview}\n${resume}`;
}
