/**
 * fable-replace — THE JOURNAL. One JSON line per CLI run, rollback and prune, so "which
 * sweeps failed this week", "what did that failure cost" and "which spec trap costs the
 * most" have an answer without re-reading session transcripts.
 *
 * Lives beside the other GenesisTools data, `<home>/.genesis-tools/fable-replace/journal.jsonl`,
 * where home is FABLE_REPLACE_HOME, else GENESIS_TOOLS_HOME (the repo's test sandbox sets it,
 * so `bun test` never writes the real file), else the user's home. Plain appends, no lock:
 * eight processes appending 250 lines each produced 2,000 well-formed lines at 400-byte and
 * 90 KB payloads. That holds for a local filesystem, never a network share. The writer never
 * throws: a failed append is one stderr line and the run's exit code stands.
 *
 * The spec text is never journaled (the file is durable, specs are source). Its size and
 * hash are. The text itself goes beside the backup, the ephemeral place.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseJson, stringifyJson } from "./json";

export type JournalOutcome =
    | "ok"
    | "miss"
    | "spec-error"
    | "pre-flight"
    | "write-failed"
    | "written"
    | "verify-failed"
    | "verify-unknown"
    | "stale-prose"
    | "dry-ok"
    | "dry-miss"
    | "partial"
    | "rollback"
    | "prune"
    | "error";

export interface JournalEntry {
    ts: string;
    runId: string;
    pid: number;
    cwd: string;
    kind: "run" | "rollback" | "prune";
    outcome: JournalOutcome;
    spec?: { files: number; ops: number; chars: number; hash: string };
    flags?: string[];
    missCount?: number;
    /** The first three MISS reasons, truncated: what aggregates into "which trap costs the most". */
    reasons?: string[];
    specError?: string;
    written?: number;
    backupDir?: string;
    verify?: {
        cmd: string;
        status: string;
        exit: number | null;
        ms: number;
        outputChars: number;
        shownLines: number;
        timedOut: boolean;
        buffered: boolean;
    };
    durationMs?: number;
    /** Everything the CLI printed: the tokens a model reads back. */
    resultChars?: number;
    tokensEst?: { spec: number; result: number };
    rollback?: { restored: number; drifted: number; failed: number };
    prune?: { removed: number; bytes: number };
    message?: string;
}

/**
 * Tokens only, never dollars: this script cannot reach the shared price catalog, and a
 * second rate table goes stale silently. A reader multiplies the spec tokens by the output
 * rate of the model that wrote them. The divisor is the measured average for code and specs.
 */
export const TOKEN_ESTIMATE = {
    charsPerToken: 3.7,
};

/** One archive at the cap; the second rotation discards the first archive. About 30 heavy sessions. */
export const JOURNAL_MAX_BYTES = 5 * 1024 * 1024;
const MAX_FIELD_CHARS = 300;
const MAX_REASON_CHARS = 80;

export const journalHome = (): string => {
    const home = process.env.FABLE_REPLACE_HOME ?? process.env.GENESIS_TOOLS_HOME ?? os.homedir();
    return path.join(home, ".genesis-tools", "fable-replace");
};

export const journalPath = (): string => path.join(journalHome(), "journal.jsonl");

const archivePath = (): string => path.join(journalHome(), "journal.1.jsonl");

export const estimateTokens = (chars: number): number => Math.round(chars / TOKEN_ESTIMATE.charsPerToken);

const clipField = (text: string, max = MAX_FIELD_CHARS): string =>
    text.length <= max ? text : `${text.slice(0, max)}…`;

/** Append one line. Never throws. Long fields are clipped so a runaway command string cannot bloat every line. */
export const appendJournal = (entry: JournalEntry): void => {
    const file = journalPath();
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const clipped: JournalEntry = {
            ...entry,
            specError: entry.specError === undefined ? undefined : clipField(entry.specError),
            reasons: entry.reasons?.slice(0, 3).map((reason) => clipField(reason, MAX_REASON_CHARS)),
            verify: entry.verify === undefined ? undefined : { ...entry.verify, cmd: clipField(entry.verify.cmd) },
            message: entry.message === undefined ? undefined : clipField(entry.message),
        };
        try {
            if (fs.statSync(file).size > JOURNAL_MAX_BYTES) {
                fs.renameSync(file, archivePath());
            }
        } catch (err) {
            if ((err as { code?: string }).code !== "ENOENT") {
                throw err;
            }
        }
        fs.appendFileSync(file, `${stringifyJson(clipped)}\n`);
    } catch (err) {
        console.error(`journal: could not append to ${file}: ${String(err)}`);
    }
};

/** Every parseable line, archive first, oldest to newest. Malformed lines are counted, never fatal. */
export const readJournal = ({ limit, sinceMs }: { limit?: number; sinceMs?: number } = {}): JournalEntry[] => {
    const entries: JournalEntry[] = [];
    let malformed = 0;
    for (const file of [archivePath(), journalPath()]) {
        if (!fs.existsSync(file)) {
            continue;
        }

        for (const line of fs.readFileSync(file, "utf8").split("\n")) {
            if (line.trim() === "") {
                continue;
            }

            try {
                entries.push(parseJson(line) as JournalEntry);
            } catch {
                malformed += 1;
            }
        }
    }
    if (malformed > 0) {
        console.error(`journal: skipped ${malformed} malformed line(s)`);
    }

    const since = sinceMs === undefined ? entries : entries.filter((entry) => Date.parse(entry.ts) >= sinceMs);
    return limit === undefined ? since : since.slice(-limit);
};

const compact = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export const printHistory = (limit: number): void => {
    const entries = readJournal({ limit });
    if (entries.length === 0) {
        console.log(`journal is empty: ${journalPath()}`);
        return;
    }

    console.log(`last ${entries.length} entries from ${journalPath()}`);
    for (const entry of entries) {
        const when = entry.ts.slice(0, 16).replace("T", " ");
        const spec = entry.spec === undefined ? "" : `${entry.spec.files}f/${entry.spec.ops}op`;
        const tokens =
            entry.tokensEst === undefined
                ? ""
                : `spec ${compact(entry.tokensEst.spec)} result ${compact(entry.tokensEst.result)} tok`;
        const verify =
            entry.verify === undefined
                ? ""
                : `verify ${entry.verify.status}${entry.verify.exit === null ? "" : ` (exit ${entry.verify.exit})`}`;
        const extra =
            entry.rollback !== undefined
                ? `restored ${entry.rollback.restored}, drifted ${entry.rollback.drifted}, failed ${entry.rollback.failed}`
                : entry.prune !== undefined
                  ? `removed ${entry.prune.removed} dir(s), ${compact(entry.prune.bytes)} B`
                  : "";
        const backup = entry.backupDir === undefined ? "" : `backup ${entry.backupDir}`;
        console.log(
            [when, entry.outcome.padEnd(14), spec.padEnd(9), tokens, verify, extra, backup]
                .filter((s) => s !== "")
                .join("  ")
        );
        if (entry.reasons !== undefined && entry.reasons.length > 0) {
            console.log(`                 ↳ ${entry.reasons.join(" | ")}`);
        }
    }
};

/** Outcomes whose spec had to be re-sent: the text cost that a better spec would have avoided. */
const WASTED = new Set<JournalOutcome>(["miss", "spec-error", "pre-flight", "write-failed", "dry-miss", "error"]);

export const printStats = (days: number): void => {
    const raw = readJournal({ sinceMs: Date.now() - days * 86_400_000 }).filter((entry) => entry.kind === "run");
    // The CLI writes a "written" breadcrumb before a verify and a terminal line after it,
    // both under one runId. A run counts once: the terminal line wins, and the breadcrumb
    // survives only for a run that never reached its terminal line (killed mid-verify).
    const byRun = new Map<string, JournalEntry>();
    for (const entry of raw) {
        const seen = byRun.get(entry.runId);
        if (seen === undefined || seen.outcome === "written") {
            byRun.set(entry.runId, entry);
        }
    }
    const entries = [...byRun.values()];
    if (entries.length === 0) {
        console.log(`no runs in the last ${days} day(s) in ${journalPath()}`);
        return;
    }

    const byOutcome = new Map<string, number>();
    const reasons = new Map<string, number>();
    let specTokens = 0;
    let resultTokens = 0;
    let wastedTokens = 0;
    let wastedRuns = 0;
    for (const entry of entries) {
        byOutcome.set(entry.outcome, (byOutcome.get(entry.outcome) ?? 0) + 1);
        specTokens += entry.tokensEst?.spec ?? 0;
        resultTokens += entry.tokensEst?.result ?? 0;
        if (WASTED.has(entry.outcome)) {
            wastedTokens += entry.tokensEst?.spec ?? 0;
            wastedRuns += 1;
        }
        for (const reason of entry.reasons ?? []) {
            const key = reason.replace(/\d+/g, "N").slice(0, 60);
            reasons.set(key, (reasons.get(key) ?? 0) + 1);
        }
    }

    const { charsPerToken } = TOKEN_ESTIMATE;
    console.log(`fable-replace runs, last ${days} day(s): ${entries.length} (${journalPath()})`);
    for (const [outcome, count] of [...byOutcome.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${outcome.padEnd(14)} ${count}`);
    }
    console.log(
        `tokens (chars ÷ ${charsPerToken}): spec ${compact(specTokens)} written by the model, result ${compact(resultTokens)} read back`
    );
    console.log(
        `wasted on ${wastedRuns} failed run(s) whose spec had to be re-sent: ${compact(wastedTokens)} spec tokens`
    );
    console.log(
        "no price here: multiply the spec tokens by the output rate of the model that wrote them. Round trips cost more than text: each failed run also bought one."
    );
    if (reasons.size > 0) {
        console.log("top MISS reasons:");
        for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
            console.log(`  ${count}× ${reason}`);
        }
    }
};
