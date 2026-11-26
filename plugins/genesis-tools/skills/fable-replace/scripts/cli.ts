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
 * Flags: --dry (preview, write nothing) · --diff [none|stat|full] (bare: print diffs on a real run too)
 *        --verify "<cmd>" (run after writing, captured and trimmed; red keeps the files) · --verify-control ts
 *        --cwd <dir> · --partial (write the files that fully passed) · --quiet (MISS/SKIP only, a stat line per file)
 *        --no-backup · --spec <file> · --api (print the typed library API) · --help
 * Code mode: --edits <file|-> (FileEdit[] as JSON) · --rename-module <file|-> · --find <pattern> · --json (one JSON
 *        object on stdout, and nothing else on either stream)
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { printApi } from "./api";
import { pruneScratch, removeEmptyDir, rollback, scratchDir } from "./backup-and-rollback";
import { FableReplaceError } from "./internal";
import { appendJournal, estimateTokens, type JournalEntry, printHistory, printStats } from "./journal";
import { recon } from "./recon";
import { renameModuleParamsFromJson, renameModuleSymbol } from "./rename-module";
import { editsFromJson, reportToJson } from "./report-json";
import { parseSpec } from "./spec";
import { run } from "./sweep-many-files";
import type { DiffLevel, FileEdit, ReconReport, RunReport, RunReportJson, VerifyControl, VerifyResult } from "./types";
import { TS_VERIFY_CONTROL } from "./verify-command";

const HELP = `fable-replace CLI — verified, transactional find/replace from a heredoc, a spec file or JSON.

usage: bun cli.ts [--dry] [--diff [none|stat|full]] [--verify "<cmd>"] [--verify-control ts] [--cwd <dir>]
                  [--partial] [--quiet] [--no-backup] [--json] < spec
       bun cli.ts --spec <file> …        # same, spec from a file (use this when a heredoc is refused or long)
       bun cli.ts --edits <file|-> …     # the batch as FileEdit[] JSON instead of a spec (- reads stdin)
       bun cli.ts --rename-module <file|-> …   # {"file","symbol","to","roots"} JSON: the symbol, its file and
                                         # every import of it; a tracked file moves with git mv; full diffs
       bun cli.ts --find <literal|/regex/flags> [--roots a,b] [--ext .ts,.tsx] [--cwd <dir>] [--json]
                                         # the files under roots (default .) that name it, with counts; writes nothing;
                                         # --ext defaults to .ts,.tsx, and --ext '' searches every file
       bun cli.ts --rollback <backupDir> [--force]   # undo a sweep from the backup dir a run printed
       bun cli.ts --api [query]          # every exported function/type with its docs; query narrows
       bun cli.ts --help

code mode (a REPL or a tool call reads the answer as data):
       --json            stdout holds exactly one JSON object, written last: the run report (v 1, ok, exitCode,
                         files with their ops, diffStat and diff, verify, warnings), or the recon report of --find.
                         Nothing else is printed on stdout or stderr (a crash stack is the only exception), so a
                         shell that merges the two parses it whole. A refusal is a run report with ok false and
                         error. A rewrite op without expectSha256 runs only with --dry; each file entry carries
                         sha256Before for the real run. Not with
                         --rollback, --prune, --history, --stats or --api.
       --diff <level>    none: each file's header line; stat: the header with +N -M; full: the diff too. Unset:
                         full on a dry run, none on a real run; --quiet alone: stat; bare --diff: full on a real run.
       --verify-control ts   before --verify, plant a probe with one type error beside the first written file;
                         a verify that does not report it ends unknown (exit 3) instead of a green pass.
       One door per call: --edits, --spec (or a spec on stdin), --rename-module or --find.
       printf '%s' "$json" | bun cli.ts --edits - --json --dry --cwd <dir>

housekeeping (below the fold on purpose):
       bun cli.ts --history [N]          # the last N journaled runs (default 20): outcome, tokens, verify, backup dir
       bun cli.ts --stats [days]         # counts per outcome, tokens written and read back, tokens wasted on failed runs
       bun cli.ts --prune                # remove this session's backup dirs older than 12 h (every sweep does this too)
       bun cli.ts --prune --all-sessions # the same gate over every session's folder and the old <tmp>/fable-replace-* layout
       Backups go to /tmp/cc/<project>/<session>/fable-replace in a Claude or Codex session, else to
       <tmp>/fable-replace/<session>. FABLE_REPLACE_SCRATCH_ROOT replaces the root; FABLE_REPLACE_SESSION and
       FABLE_REPLACE_HARNESS (claude|codex|grok) name the session.
       Every real run (never --dry), rollback and prune is journaled to ~/.genesis-tools/fable-replace/journal.jsonl
       (GENESIS_TOOLS_HOME or FABLE_REPLACE_HOME move it). The input is saved beside the backup, never there.

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
  <<< delete symbol=<name> | doc=<name>   (empty body) the declaration with its doc comment and
                                   attributes, or only the doc comment above it
  <<< block   (from === to === replacement)   replace a region; empty replacement deletes it
  <<< create  (whole file content) create a new file; refuses an existing one
  <<< move to=<path> symbol=<name> | lines=<a>-<b>   (empty body) cut the block here, paste it there;
                                   a target that does not exist is created. at=after|before puts it
                                   against the body as anchor. imports=fix: the target gains the imports
                                   the block uses, this file drops the ones only the block used, and
                                   every importer of a moved export is re-pointed (TS/JS, Swift, PHP).
                                   visibility=widen also exports or widens what must cross the cut.
                                   Every refusal and warning prints the spec text that fixes it.

Bodies are raw, line for line. Only a line that is exactly === or >>> is special inside a block:
write such a line as \\=== or \\>>>. Ops apply in order, each sees the previous op's output.
Build spec text with printf '%s\\n', never echo (zsh echo turns \\b into a backspace byte).
Nothing is written unless every required op matches. Backups go to a fresh scratch dir (printed).
A MISS names the line to re-read; a spec error names the spec line.
`;

const VALUE_FLAGS = [
    "--verify",
    "--cwd",
    "--spec",
    "--rollback",
    "--edits",
    "--rename-module",
    "--roots",
    "--ext",
    "--verify-control",
];
// A --find pattern may start with "--" itself (a search for "--dry" is a fair question), so it takes the next
// argument whatever it holds.
const PATTERN_FLAGS = ["--find"];
const OPTIONAL_VALUE_FLAGS = ["--api", "--history", "--stats", "--diff"];
const BOOL_FLAGS = [
    "--dry",
    "--json",
    "--partial",
    "--quiet",
    "--no-backup",
    "--force",
    "--prune",
    "--all-sessions",
    "--help",
    "-h",
];
// Each door reads the batch its own way; with two, one of them would be dropped without a word.
const DOORS = ["--edits", "--spec", "--rename-module", "--find"];
const NOT_WITH_JSON = ["--rollback", "--prune", "--history", "--stats", "--api"];
const DIFF_LEVELS: readonly DiffLevel[] = ["none", "stat", "full"];
const VERIFY_CONTROLS = new Map<string, VerifyControl>([["ts", TS_VERIFY_CONTROL]]);

const argv = process.argv.slice(2);
// Read before the parse, so a usage error the parse finds is a JSON answer too.
const jsonMode = argv.includes("--json");
const values = new Map<string, string>();
const flags = new Set<string>();
let printedChars = 0;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The one object --json puts on stdout. Awaited before any exit, so a pipe never gets a cut object. */
const writeJson = async (report: RunReportJson | ReconReport): Promise<void> => {
    const text = `${JSON.stringify(report)}\n`;
    printedChars += text.length;
    await Bun.write(Bun.stdout, text);
};

/** Ends the process with `code`; in --json mode the report goes to stdout first. */
const finish = async (code: number, report: RunReportJson | ReconReport): Promise<never> => {
    if (jsonMode) {
        await writeJson(report);
    }

    process.exit(code);
};

/** A refusal before anything ran: exit 2, and in --json mode a run report with ok false that says why. */
const refuse = async (message: string): Promise<never> => {
    // Under --json the message is the report's error, and nothing else is printed.
    if (!jsonMode) {
        console.error(message);
    }

    return finish(2, reportToJson({ error: new FableReplaceError(message, 2), dryRun: argv.includes("--dry") }));
};

for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (VALUE_FLAGS.includes(arg) || PATTERN_FLAGS.includes(arg)) {
        const next = argv[i + 1];
        if (next === undefined || (VALUE_FLAGS.includes(arg) && next.startsWith("--"))) {
            await refuse(`${arg} needs a value. Run with --help.`);
        } else {
            values.set(arg, next);
            i += 1;
        }
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
        const known = [
            ...BOOL_FLAGS,
            ...VALUE_FLAGS,
            "--find <pattern>",
            "--diff [none|stat|full]",
            "--api [query]",
            "--history [N]",
            "--stats [days]",
        ];
        await refuse(`unknown argument "${arg}". Known flags: ${known.join(" ")}. Nothing was done.`);
    }
}

const flag = (name: string): boolean => flags.has(name);
const value = (name: string): string | undefined => values.get(name);

const diffValue = value("--diff");
const diffLevel = DIFF_LEVELS.find((level) => level === diffValue);
if (diffValue !== undefined && diffLevel === undefined) {
    await refuse(`--diff takes none, stat or full, not "${diffValue}". Nothing was done.`);
}

const controlName = value("--verify-control");
const verifyControl = controlName === undefined ? undefined : VERIFY_CONTROLS.get(controlName);
if (controlName !== undefined && verifyControl === undefined) {
    await refuse(
        `--verify-control takes ${[...VERIFY_CONTROLS.keys()].join(", ")}, not "${controlName}". Nothing was done.`
    );
}

const doors = DOORS.filter((name) => values.has(name));
if (doors.length > 1) {
    await refuse(`one door per call, but ${doors.join(" and ")} were given. Nothing was done.`);
}

const notWithJson = NOT_WITH_JSON.filter((name) => flags.has(name) || values.has(name));
if (jsonMode && notWithJson.length > 0) {
    await refuse(`--json answers a run or --find, not ${notWithJson.join(" or ")}. Nothing was done.`);
}

const findOnly = ["--roots", "--ext"].filter((name) => values.has(name));
if (findOnly.length > 0 && !values.has("--find")) {
    await refuse(`${findOnly.join(" and ")} narrow --find only. Nothing was done.`);
}

// Before the console wrapper: the help text is the one answer that stays on stdout under --json.
if (flag("--help") || flag("-h")) {
    console.log(HELP);
    process.exit(0);
}

// Everything the CLI prints is what a model reads back, so count it for the journal. Bun's
// console writes natively and never passes through process.stdout.write, so the console
// methods themselves are wrapped; each still calls the original, nothing else changes. Under
// --json they print nothing: a code-mode shell merges stdout and stderr, so one human line breaks
// its parse, and the report already carries the ops, their reasons, the warnings and the verify.
// An uncaught crash still prints its stack, because Bun writes that past these wrappers.
for (const name of ["log", "error", "warn", "info"] as const) {
    const original = console[name].bind(console);
    console[name] = (...args: unknown[]): void => {
        if (jsonMode) {
            return;
        }

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
    // FABLE_REPLACE_SESSION first: the MCP tool names its caller's session there.
    session:
        process.env.FABLE_REPLACE_SESSION ||
        process.env.CLAUDE_CODE_SESSION_ID ||
        process.env.CODEX_THREAD_ID ||
        undefined,
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
    // backup dir excluded. Silent unless it removed something. The --cwd value, not the
    // `cwd` const: this hook also runs for an exit before that const exists.
    const pruned = pruneScratch({
        keep: entry.backupDir === undefined ? [] : [entry.backupDir],
        scratch: { cwd: value("--cwd") },
    });
    if (pruned.removed > 0) {
        // In --json mode the report must stay the last line a caller reads, also where stdout and stderr merge
        // (a code-mode script's shell): the journal keeps the prune, so the line is printed only for a person.
        if (!jsonMode) {
            console.log(
                `pruned ${pruned.removed} stale scratch dir(s) older than 12 h under ${pruned.roots.join(" and ")}`
            );
        }
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
        ...file.ops
            .filter((op) => op.status === "MISS" || op.status === "NOOP")
            .map((op) => `${file.file}: ${op.desc}: ${op.reason ?? ""}`),
        ...file.postConditionFailures.map((failure) => `${file.file}: ${failure}`),
    ]);

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
    const report = pruneScratch({ scope: flag("--all-sessions") ? "all-sessions" : "session" });
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

// The folder every relative path of a run or a search resolves against.
const cwd = value("--cwd") ?? process.cwd();

/** `/source/flags` is a RegExp; anything else is a literal (an identifier-shaped one matches on word bounds). */
const findPattern = (raw: string): string | RegExp => {
    const match = /^\/(.+)\/([dgimsuvy]*)$/s.exec(raw);
    return match === null ? raw : new RegExp(match[1], match[2]);
};

const listValue = (name: string): string[] | undefined =>
    value(name)
        ?.split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

const printRecon = (report: ReconReport): void => {
    console.log(
        `${report.pattern}: ${report.total} match(es) in ${report.files.length} file(s) under ${report.roots.join(", ")}`
    );
    for (const row of report.files) {
        console.log(`  ${row.file}  ${row.count}${row.declares ? "  declares it" : ""}`);
    }
};

/** --find: read-only, so it is not journaled and never prunes. */
const findDoor = async (raw: string): Promise<never> => {
    let pattern: string | RegExp;
    try {
        pattern = findPattern(raw);
    } catch (err) {
        return refuse(`--find: ${errorText(err)}. Nothing was done.`);
    }

    let report: ReconReport;
    try {
        report = recon({ roots: listValue("--roots") ?? ["."], pattern, exts: listValue("--ext"), cwd });
    } catch (err) {
        console.error(`FIND ERROR: ${errorText(err)}`);
        return finish(err instanceof FableReplaceError ? err.code : 1, reportToJson({ error: err, dryRun: false }));
    }

    if (!jsonMode) {
        printRecon(report);
    }

    return finish(0, report);
};

type RunDoor = "spec" | "edits" | "rename-module";

// The input is saved beside the backup under this name, with the originals it edited.
const SAVED_INPUT: Record<RunDoor, string> = {
    spec: "spec.frspec",
    edits: "edits.json",
    "rename-module": "rename-module.json",
};

const parseJsonInput = (text: string, door: RunDoor): unknown => {
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new FableReplaceError(`--${door}: the input is not JSON (${errorText(err)})`, 2);
    }
};

/** A spec, FileEdit[] JSON or rename-module JSON, run through run(); in --json mode the report is the answer. */
const runDoor = async (): Promise<void> => {
    const door: RunDoor = values.has("--edits") ? "edits" : values.has("--rename-module") ? "rename-module" : "spec";
    const source = value(`--${door}`);
    // "-" is stdin for the JSON doors; a spec reads stdin when no --spec file is given.
    const inputPath = source === undefined || (door !== "spec" && source === "-") ? undefined : source;
    const dryRun = flag("--dry");
    // A spec warns while it is parsed, before run(), so the report takes its warnings from here.
    const specWarnings: string[] = [];
    const refusal = (message: string): RunReportJson =>
        reportToJson({ error: new FableReplaceError(message, 2), dryRun, warnings: specWarnings });

    // Journal from here on: input that cannot be read, or an empty one, is a failed run too,
    // and used to leave no trace in --history.
    entry.flags = [...flags, ...values.keys()];
    journalThisRun = true;
    let text: string;
    try {
        text = fs.readFileSync(inputPath ?? 0, "utf8");
    } catch (err) {
        entry.outcome = "spec-error";
        entry.message = `cannot read ${inputPath ?? "stdin"}: ${errorText(err)}`;
        console.error(`SPEC ERROR: ${entry.message}`);
        return finish(2, refusal(entry.message));
    }

    if (text.trim().length === 0) {
        entry.outcome = "spec-error";
        if (door === "spec") {
            entry.message = "no spec on stdin and no --spec file";
            console.error(
                "no spec on stdin and no --spec file. Run with --help for the format. If you wrote a heredoc, it did not reach this process: the delimiter line must close it and no body line may equal the delimiter. Or write the spec to a file and pass --spec <file>."
            );
        } else {
            entry.message = `no JSON from --${door} ${inputPath ?? "- (stdin)"}`;
            console.error(
                `${entry.message}. Pipe it in (printf '%s' "$json" | bun cli.ts --${door} -) or pass a file.`
            );
        }

        return finish(2, refusal(entry.message));
    }

    entry.spec = {
        files: 0,
        ops: 0,
        chars: text.length,
        hash: createHash("sha256").update(text).digest("hex").slice(0, 12),
    };

    // A rename-module JSON may name its own cwd, read against --cwd; the run and its backups use it.
    let runCwd = cwd;
    let edits: FileEdit[];
    try {
        if (door === "edits") {
            edits = editsFromJson(parseJsonInput(text, door));
        } else if (door === "rename-module") {
            const params = renameModuleParamsFromJson(parseJsonInput(text, door));
            runCwd = path.resolve(cwd, params.cwd ?? ".");
            edits = renameModuleSymbol({ ...params, cwd: runCwd });
        } else {
            // A move marker reads its files while the spec is parsed.
            edits = parseSpec({
                text,
                cwd,
                onWarning: (message) => {
                    specWarnings.push(message);
                    console.error(`WARNING: ${message}`);
                },
            });
        }
    } catch (err) {
        entry.outcome = "spec-error";
        entry.specError = errorText(err);
        console.error(`SPEC ERROR: ${entry.specError}`);
        return finish(2, refusal(entry.specError));
    }

    const opCount = edits.reduce((sum, e) => sum + (e.ops?.length ?? 0), 0);
    entry.spec.files = edits.length;
    entry.spec.ops = opCount;
    const creates = edits.filter((e) => e.createWith !== undefined).length;
    console.log(
        `${door}: ${edits.length} file(s), ${opCount} op(s)${creates > 0 ? `, ${creates} create` : ""}${dryRun ? " — DRY RUN" : ""}`
    );

    // The run backs up into this folder only when it writes; a run that writes nothing leaves it empty, and the
    // folder goes again, so no empty backup reads as one to roll back to.
    const backupDir = flag("--no-backup") || dryRun ? undefined : scratchDir("cli", { cwd: runCwd });
    let report: RunReport;
    try {
        report = await run({
            edits,
            cwd: runCwd,
            dryRun,
            showDiff: flag("--diff"),
            // --quiet alone keeps a dry run short: a stat line per file instead of every diff.
            diff: diffLevel ?? (flag("--quiet") && !flag("--diff") ? "stat" : undefined),
            verbose: !flag("--quiet"),
            partial: flag("--partial"),
            backupDir,
            verifyCommand: value("--verify"),
            verifyControl,
            throwOnFailure: true,
            onWritten: ({ written, backupDir }) => {
                if (backupDir !== undefined) {
                    // The ephemeral place for the input: collected with the originals it edited.
                    try {
                        fs.writeFileSync(path.join(backupDir, SAVED_INPUT[door]), text);
                    } catch (err) {
                        console.error(`could not save the input beside the backup: ${String(err)}`);
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
    } catch (err) {
        removeEmptyDir(backupDir);
        if (err instanceof FableReplaceError) {
            const failed = err.report;
            entry.written = failed?.written.length;
            entry.backupDir = failed?.backupDir;
            entry.missCount = failed?.missCount;
            entry.reasons = missReasons(failed);
            entry.verify = journalVerify(failed?.verify);
            entry.message = err.message;
            if (err.code === 2) {
                entry.outcome = "pre-flight";
            } else if (err.code === 3) {
                const verifyStatus = failed?.verify?.status;
                entry.outcome =
                    verifyStatus === "unknown"
                        ? "verify-unknown"
                        : verifyStatus === "fail"
                          ? "verify-failed"
                          : err.message.includes("backup manifest not updated")
                            ? "written"
                            : "stale-prose";
            } else if (dryRun) {
                entry.outcome = "dry-miss";
            } else if (err.message.startsWith("fable-replace: write failed")) {
                entry.outcome = "write-failed";
            } else if (flag("--partial") && (failed?.written.length ?? 0) > 0) {
                entry.outcome = "partial";
            } else {
                entry.outcome = "miss";
            }

            return finish(err.code, reportToJson({ error: err, dryRun, warnings: specWarnings }));
        }

        entry.message = errorText(err);
        console.error(`ERROR: ${entry.message}`);
        return finish(1, reportToJson({ error: err, dryRun, warnings: specWarnings }));
    }

    removeEmptyDir(backupDir);
    entry.outcome = dryRun ? "dry-ok" : "ok";
    entry.written = report.written.length;
    entry.backupDir = report.backupDir;
    entry.verify = journalVerify(report.verify);
    if (jsonMode) {
        await writeJson(reportToJson({ report, dryRun, warnings: specWarnings }));
    }
};

const findValue = value("--find");
if (findValue !== undefined) {
    await findDoor(findValue);
}

await runDoor();
