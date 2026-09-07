#!/usr/bin/env bun
/**
 * fable-replace — THE CLI. One call, zero ceremony, verified and transactional:
 *
 *   bun "${CLAUDE_PLUGIN_ROOT}/skills/fable-replace/scripts/cli.ts" <<'EOF'
 *   @@ src/foo.ts
 *   <<<
 *   const gate = getLinkGate(link);
 *   ===
 *   const gate = getActionDisabledState(link);
 *   >>>
 *   EOF
 *
 * Reads the spec from stdin (or --spec <file>), applies every op in memory, writes
 * only when ALL of them matched, backs up first, prints one OK/MISS line per op and
 * a hint on every MISS. Exit 0 = everything landed. Exit 1 = nothing written.
 * Exit 3 = written, but the verify failed (the sweep stays; the undo command is printed).
 *
 * Flags: --dry (preview, write nothing) · --diff (print diffs on a real run too)
 *        --verify "<cmd>" (run after writing, captured and trimmed; red keeps the files) · --cwd <dir>
 *        --partial (write the files that fully passed) · --quiet (MISS/SKIP only)
 *        --no-backup · --spec <file> · --api (print the typed library API) · --help
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { printApi } from "./api";
import { pruneScratch, rollback, scratchDir, scratchRoot } from "./backup-and-rollback";
import { FableReplaceError } from "./internal";
import { appendJournal, estimateTokens, type JournalEntry, printHistory, printStats } from "./journal";
import { parseSpec } from "./spec";
import { run } from "./sweep-many-files";
import type { RunReport, VerifyResult } from "./types";

const HELP = `fable-replace CLI — verified, transactional find/replace from a heredoc or a spec file.

usage: bun cli.ts [--dry] [--diff] [--verify "<cmd>"] [--cwd <dir>] [--partial] [--quiet] [--no-backup] < spec
       bun cli.ts --spec <file> …        # same, spec from a file (use this when a heredoc is refused or long)
       bun cli.ts --rollback <backupDir> [--force]   # undo a sweep from the backup dir a run printed
       bun cli.ts --api [query]          # every exported function/type with its docs; query narrows
       bun cli.ts --help

housekeeping (below the fold on purpose):
       bun cli.ts --history [N]          # the last N journaled runs (default 20): outcome, tokens, verify, backup dir
       bun cli.ts --stats [days]         # counts per outcome, tokens written and read back, tokens wasted on failed runs
       bun cli.ts --prune                # remove backup dirs older than 12 h under <tmp>/fable-replace/ (every sweep does this too)
       Every real run (never --dry), rollback and prune is journaled to ~/.genesis-tools/fable-replace/journal.jsonl
       (GENESIS_TOOLS_HOME or FABLE_REPLACE_HOME move it). The spec text is saved beside the backup, never there.

exit 0  everything landed (or the dry run is clean)     exit 1  a MISS: nothing written (a partial write with misses is 1 too)
exit 2  bad spec, unknown flag, a --verify with | ; or &   exit 3  the sweep IS written, but the verify failed or stale prose survived
An unknown flag is an ERROR: "--dyr" never becomes a real write. After exit 3, fix forward with a small
follow-up spec, or run the --rollback line the failure printed; never re-send the same spec.

spec (git-marker shaped, no escaping, heredoc-friendly; pick a delimiter that cannot appear in bodies, e.g. FRSPEC):

  @@ path/to/file.ts            start a file section
  expect: text                  optional: must be present after the ops (repeatable)
  absent: text                  optional: must be absent after the ops (repeatable)
  <<<                           literal replace, exactly once (the workhorse)
  old text (verbatim, indentation included)
  ===
  new text
  >>>
  <<< count=all | count=3 | optional | label=free text
  <<< regex flags=gi            find is a JS regex; replace may use $1 ($$ for a literal $, $& is the match); count=N pins matches
  <<< fuzzy                     whitespace-insensitive FIND; the replacement is written verbatim
  <<< after   (anchor === lines)   insert whole lines after the line holding the unique anchor; the anchor line stays, never repeat it
  <<< before  (anchor === lines)   same, above it
  <<< append  (lines)              append at end of file
  <<< delete  (lines)              remove these lines, newline included
  <<< block   (from === to === replacement)   replace a region; empty replacement deletes it
  <<< create  (whole file content) create a new file; refuses an existing one

Bodies are raw, line for line. Only a line that is exactly === or >>> is special inside a block:
write such a line as \\=== or \\>>>. Ops apply in order, each sees the previous op's output.
Build spec text with printf '%s\\n', never echo (zsh echo turns \\b into a backspace byte).
Nothing is written unless every required op matches. Backups go to a fresh temp dir (printed).
A MISS names the line to re-read; a spec error names the spec line.
`;

const VALUE_FLAGS = ["--verify", "--cwd", "--spec", "--rollback"];
const OPTIONAL_VALUE_FLAGS = ["--api", "--history", "--stats"];
const BOOL_FLAGS = ["--dry", "--diff", "--partial", "--quiet", "--no-backup", "--force", "--prune", "--help", "-h"];
const argv = process.argv.slice(2);
const values = new Map<string, string>();
const flags = new Set<string>();

for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (VALUE_FLAGS.includes(arg)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
            console.error(`${arg} needs a value. Run with --help.`);
            process.exit(2);
        }
        values.set(arg, next);
        i += 1;
    } else if (OPTIONAL_VALUE_FLAGS.includes(arg)) {
        flags.add(arg);
        if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
            values.set(arg, argv[i + 1]);
            i += 1;
        }
    } else if (BOOL_FLAGS.includes(arg)) {
        flags.add(arg);
    } else {
        // Silently ignoring "--dyr" once turned a preview into a real write.
        console.error(
            `unknown argument "${arg}". Known flags: ${[...BOOL_FLAGS, ...VALUE_FLAGS, "--api [query]", "--history [N]", "--stats [days]"].join(" ")}. Nothing was done.`
        );
        process.exit(2);
    }
}

const flag = (name: string): boolean => flags.has(name);
const value = (name: string): string | undefined => values.get(name);

// Everything the CLI prints is what a model reads back, so count it for the journal. Bun's
// console writes natively and never passes through process.stdout.write, so the console
// methods themselves are wrapped; each still calls the original, nothing else changes.
let printedChars = 0;
for (const name of ["log", "error", "warn", "info"] as const) {
    const original = console[name].bind(console);
    console[name] = (...args: unknown[]): void => {
        printedChars += format(...args).length + 1;
        original(...args);
    };
}

// One journal line per run or rollback, written on exit whatever path got there. The
// exit hook is the single place, so a spec error, a pre-flight refusal and a MISS are
// recorded by the same code as a green sweep. Help, --api, --history and --stats skip it.
const startedAt = Date.now();
const entry: JournalEntry = {
    ts: new Date(startedAt).toISOString(),
    runId: `${startedAt.toString(36)}-${process.pid}`,
    pid: process.pid,
    cwd: process.cwd(),
    kind: "run",
    outcome: "error",
};
let journalThisRun = false;
process.on("exit", () => {
    // A dry run is a preview: it writes nothing, not even the journal, and it never prunes.
    if (!journalThisRun || flag("--dry")) {
        return;
    }

    entry.durationMs = Date.now() - startedAt;
    entry.resultChars = printedChars;
    entry.tokensEst = { spec: estimateTokens(entry.spec?.chars ?? 0), result: estimateTokens(printedChars) };
    appendJournal(entry);

    // Housekeeping rides on every run: age-only, manifest-gated, capped, this run's own
    // backup dir excluded. Silent unless it removed something.
    const pruned = pruneScratch({ keep: entry.backupDir === undefined ? [] : [entry.backupDir] });
    if (pruned.removed > 0) {
        console.log(`pruned ${pruned.removed} stale scratch dir(s) older than 12 h under ${scratchRoot()}`);
        appendJournal({
            ...entry,
            kind: "prune",
            outcome: "prune",
            prune: { removed: pruned.removed, bytes: pruned.bytes },
        });
    }
});

const journalVerify = (verify: VerifyResult | undefined): JournalEntry["verify"] =>
    verify === undefined
        ? undefined
        : {
              cmd: verify.command,
              status: verify.status,
              exit: verify.exitCode,
              ms: verify.ms,
              outputChars: verify.outputChars,
              shownLines: verify.shown.length,
              timedOut: verify.timedOut,
              buffered: verify.buffered,
          };

const missReasons = (report: RunReport | undefined): string[] =>
    (report?.files ?? []).flatMap((file) => [
        ...file.ops.filter((op) => op.status === "MISS").map((op) => `${file.file}: ${op.desc}: ${op.reason ?? ""}`),
        ...file.postConditionFailures.map((failure) => `${file.file}: ${failure}`),
    ]);

if (flag("--help") || flag("-h")) {
    console.log(HELP);
    process.exit(0);
}
if (flag("--api")) {
    printApi({ dir: path.dirname(fileURLToPath(import.meta.url)), query: value("--api") });
    process.exit(0);
}
if (flag("--history")) {
    printHistory(Number(value("--history") ?? 20) || 20);
    process.exit(0);
}
if (flag("--stats")) {
    printStats(Number(value("--stats") ?? 7) || 7);
    process.exit(0);
}
if (flag("--prune")) {
    const report = pruneScratch();
    console.log(
        `pruned ${report.removed} stale scratch dir(s), ${Math.round(report.bytes / 1024)} KB, older than 12 h, under ${report.roots.join(" and ")} (${report.scanned} scanned)`
    );
    appendJournal({
        ...entry,
        kind: "prune",
        outcome: "prune",
        prune: { removed: report.removed, bytes: report.bytes },
    });
    process.exit(0);
}

const rollbackDir = value("--rollback");
if (rollbackDir !== undefined) {
    entry.kind = "rollback";
    entry.backupDir = rollbackDir;
    entry.flags = [...flags];
    journalThisRun = true;
    try {
        const report = rollback({ backupDir: rollbackDir, force: flag("--force") });
        entry.outcome = "rollback";
        entry.rollback = {
            restored: report.restored.length,
            drifted: report.drifted.length,
            failed: report.failed.length,
        };
        process.exit(report.drifted.length > 0 || report.failed.length > 0 ? 1 : 0);
    } catch (err) {
        entry.message = err instanceof Error ? err.message : String(err);
        console.error(`ROLLBACK ERROR: ${entry.message}`);
        process.exit(2);
    }
}

const specPath = value("--spec");
// Journal from here on: a spec that cannot be read, or an empty one, is a failed run too,
// and used to leave no trace in --history.
entry.flags = [...flags, ...values.keys()];
journalThisRun = true;
let text: string;
try {
    text = fs.readFileSync(specPath ?? 0, "utf8");
} catch (err) {
    entry.outcome = "spec-error";
    entry.message = `cannot read ${specPath ?? "stdin"}: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`SPEC ERROR: ${entry.message}`);
    process.exit(2);
}
if (text.trim().length === 0) {
    entry.outcome = "spec-error";
    entry.message = "no spec on stdin and no --spec file";
    console.error(
        "no spec on stdin and no --spec file. Run with --help for the format. If you wrote a heredoc, it did not reach this process: the delimiter line must close it and no body line may equal the delimiter. Or write the spec to a file and pass --spec <file>."
    );
    process.exit(2);
}
entry.spec = {
    files: 0,
    ops: 0,
    chars: text.length,
    hash: createHash("sha256").update(text).digest("hex").slice(0, 12),
};

let edits: ReturnType<typeof parseSpec>;
try {
    edits = parseSpec({ text, onWarning: (message) => console.error(`WARNING: ${message}`) });
} catch (err) {
    entry.outcome = "spec-error";
    entry.specError = err instanceof Error ? err.message : String(err);
    console.error(`SPEC ERROR: ${entry.specError}`);
    process.exit(2);
}

const cwd = value("--cwd") ?? process.cwd();

const opCount = edits.reduce((sum, e) => sum + (e.ops?.length ?? 0), 0);
entry.spec.files = edits.length;
entry.spec.ops = opCount;
const creates = edits.filter((e) => e.createWith !== undefined).length;
console.log(
    `spec: ${edits.length} file(s), ${opCount} op(s)${creates > 0 ? `, ${creates} create` : ""}${flag("--dry") ? " — DRY RUN" : ""}`
);

try {
    const report = await run({
        edits,
        cwd,
        dryRun: flag("--dry"),
        showDiff: flag("--diff"),
        verbose: !flag("--quiet"),
        partial: flag("--partial"),
        backupDir: flag("--no-backup") || flag("--dry") ? undefined : scratchDir("cli"),
        verifyCommand: value("--verify"),
        throwOnFailure: true,
        onWritten: ({ written, backupDir }) => {
            if (backupDir !== undefined) {
                // The ephemeral place for the spec text: collected with the originals it edited.
                try {
                    fs.writeFileSync(path.join(backupDir, "spec.frspec"), text);
                } catch (err) {
                    console.error(`could not save the spec beside the backup: ${String(err)}`);
                }
            }

            if (value("--verify") !== undefined) {
                // A check the Bash tool kills mid-run never reaches the exit hook; this line proves
                // the sweep landed before it started.
                appendJournal({
                    ...entry,
                    outcome: "written",
                    written: written.length,
                    backupDir,
                    durationMs: Date.now() - startedAt,
                    resultChars: printedChars,
                });
            }
        },
    });
    entry.outcome = flag("--dry") ? "dry-ok" : "ok";
    entry.written = report.written.length;
    entry.backupDir = report.backupDir;
    entry.verify = journalVerify(report.verify);
} catch (err) {
    if (err instanceof FableReplaceError) {
        const report = err.report;
        entry.written = report?.written.length;
        entry.backupDir = report?.backupDir;
        entry.missCount = report?.missCount;
        entry.reasons = missReasons(report);
        entry.verify = journalVerify(report?.verify);
        entry.message = err.message;
        if (err.code === 2) {
            entry.outcome = "pre-flight";
        } else if (err.code === 3) {
            const verifyStatus = report?.verify?.status;
            entry.outcome =
                verifyStatus === "unknown"
                    ? "verify-unknown"
                    : verifyStatus === "fail"
                      ? "verify-failed"
                      : err.message.includes("backup manifest not updated")
                        ? "written"
                        : "stale-prose";
        } else if (flag("--dry")) {
            entry.outcome = "dry-miss";
        } else if (err.message.startsWith("fable-replace: write failed")) {
            entry.outcome = "write-failed";
        } else if (flag("--partial") && (report?.written.length ?? 0) > 0) {
            entry.outcome = "partial";
        } else {
            entry.outcome = "miss";
        }
        process.exit(err.code);
    }
    entry.message = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: ${entry.message}`);
    process.exit(1);
}
