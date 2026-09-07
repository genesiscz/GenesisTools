/**
 * fable-replace — THE RUNNER. Applying a batch of FileEdits across many files,
 * transactionally.
 *
 * Every file is read and every op applied IN MEMORY first. Only if all required ops
 * matched, all post-conditions held and every edited script still parses does
 * anything get written. One required MISS aborts the whole batch.
 *
 * It also refuses, in pre-flight: node_modules paths, machine-generated files, a
 * renameTo onto an existing file, and a reused backupDir.
 *
 * `verifyCommand` runs your project's own check after a successful write. USE IT. Every
 * op reporting OK only proves the ops you DECLARED matched; it cannot know about a call
 * site your recon never found. A red check keeps the sweep written and exits 3: rolling
 * back would restore the very needles a re-sent spec matches, and the loop that follows
 * costs a full-context round trip per turn. The files stay; the undo command is printed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { backupDirInUse, recordPostWriteHashes, rollback, writeBackup } from "./backup-and-rollback";
import { scanComments } from "./comments";
import { applyOps } from "./edit-one-file";
import { COLORS, changedOnDisk, FableReplaceError, paint, preview } from "./internal";
import { leftovers } from "./recon";
import type { FileEdit, FileResult, RunParams, RunReport, SimpleDiffParams, VerifyResult } from "./types";
import { checkVerifyCommand, runVerifyCommand, verifyUnknownReason } from "./verify-command";

/**
 * Roll a failed sweep back and return the files the rollback itself could NOT restore.
 * Those still hold the rejected content, so the caller must name them: an exit code
 * alone reads as a routine failure, and the user trusts "or not at all".
 */
const strandedByRollback = ({ backupDir, touched }: { backupDir: string; touched: string[] }): string[] => {
    // Only the paths this sweep wrote. A file the changed-on-disk guard refused holds someone
    // else's write, and a file after the failure was never touched: restoring either from
    // the snapshot would destroy exactly what the guard protected.
    console.error(paint(COLORS.miss, `rolling back the ${touched.length} path(s) this sweep wrote.`));
    const report = rollback({ backupDir, force: true, only: touched });
    return report.failed.map((f) => f.file);
};

const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");

/**
 * The failure block a reader must not misread. Its first sentence answers the only
 * question that matters after a red check: the files ARE written. A rollback here would
 * restore the originals, and the model's instinct to re-send the whole spec would then
 * succeed, go red again, and loop. Keeping the files makes a blind re-send MISS instead,
 * which is a hard stop with a hint.
 */
const printVerifyFailure = ({
    verify,
    written,
    backupDir,
}: {
    verify: VerifyResult;
    written: string[];
    backupDir?: string;
}): void => {
    const verdict =
        verify.status === "fail"
            ? `VERIFY FAILED (exit ${String(verify.exitCode)})`
            : `VERIFY UNKNOWN (${verifyUnknownReason(verify)})`;
    console.error(
        paint(
            COLORS.miss,
            `\nSWEEP WRITTEN, ${verdict}. The ${written.length} file(s) above hold the sweep. Do NOT re-send this spec.`
        )
    );
    console.error("Fix forward with a small follow-up spec, or undo everything with:");
    console.error(
        backupDir === undefined
            ? "  (no backup dir: this run used --no-backup, so undo it with git: `git diff`, then `git stash push -- <files>`)"
            : `  bun "${CLI_PATH}" --rollback "${backupDir}"`
    );
    for (const line of verify.shown) {
        console.error(`  ${line}`);
    }
    if (verify.outputFile !== undefined) {
        console.error(paint(COLORS.dim, `full verify output: ${verify.outputFile}`));
    }
};

/**
 * Line diff for dry runs. Patience-style: it trims the common prefix/suffix, then
 * splits the remaining window on lines that occur exactly once on BOTH sides and
 * recurses. That keeps two edits 40 lines apart as two small hunks instead of one
 * 40-line block, which used to overstate the blast radius of a multi-hit sweep.
 */
const diffRegion = (a: string[], b: string[], aStart: number, out: string[], depth = 0): void => {
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
        prefix += 1;
    }
    let suffix = 0;
    while (
        suffix < a.length - prefix &&
        suffix < b.length - prefix &&
        a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
    ) {
        suffix += 1;
    }
    const aMid = a.slice(prefix, a.length - suffix);
    const bMid = b.slice(prefix, b.length - suffix);
    if (aMid.length === 0 && bMid.length === 0) {
        return;
    }
    const midStart = aStart + prefix;

    // find a unique common anchor line to split on (patience diff)
    if (depth < 40 && aMid.length > 0 && bMid.length > 0) {
        const countIn = (arr: string[]): Map<string, number> => {
            const m = new Map<string, number>();
            for (const l of arr) {
                m.set(l, (m.get(l) ?? 0) + 1);
            }
            return m;
        };
        const ca = countIn(aMid);
        const cb = countIn(bMid);
        let anchorA = -1;
        let anchorB = -1;
        for (let i = 0; i < aMid.length; i += 1) {
            const line = aMid[i];
            if (line.trim() === "" || ca.get(line) !== 1 || cb.get(line) !== 1) {
                continue;
            }
            anchorA = i;
            anchorB = bMid.indexOf(line);
            break;
        }
        if (anchorA !== -1 && anchorB !== -1) {
            diffRegion(aMid.slice(0, anchorA), bMid.slice(0, anchorB), midStart, out, depth + 1);
            diffRegion(aMid.slice(anchorA + 1), bMid.slice(anchorB + 1), midStart + anchorA + 1, out, depth + 1);
            return;
        }
    }

    out.push(`@@ line ${midStart + 1} (−${aMid.length} +${bMid.length}) @@`);
    for (const l of aMid) {
        out.push(`- ${l}`);
    }
    for (const l of bMid) {
        out.push(`+ ${l}`);
    }
};

export const simpleDiff = ({ before, after, maxLines = 200 }: SimpleDiffParams): string => {
    const out: string[] = [];
    diffRegion(before.split("\n"), after.split("\n"), 0, out);
    if (out.length === 0) {
        return "(no line-level change)";
    }
    if (out.length > maxLines) {
        const hidden = out.length - maxLines;
        return [...out.slice(0, maxLines), `… (${hidden} more diff lines)`].join("\n");
    }
    return out.join("\n");
};

// A sweep that edits generated output looks perfect and typechecks, then vanishes on
// the next codegen run. SKILL.md always said "never point ops at generated files";
// this makes the rule mechanical instead of advisory.
const GENERATED_PATH_RE =
    /(^|[/\\])(dist|build|out|coverage)[/\\]|\.(gen|generated)\.[cm]?[jt]sx?$|\.pb\.[cm]?[jt]s$|_pb2?\.[cm]?[jt]s$/;

const GENERATED_HEADER_RE =
    /@generated|code generated by|automatically generated|auto-generated|do not (make any changes|edit|modify)/i;

/** Why `file` looks machine-generated, or null when it does not. */
export const looksGenerated = (file: string): string | null => {
    if (GENERATED_PATH_RE.test(file)) {
        return "path looks generated";
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return null;
    }
    const head = fs.readFileSync(file, "utf8").split("\n").slice(0, 60).join("\n");
    // In source files only a REAL COMMENT counts. A hand-written module whose job is
    // to EMIT "auto-generated, do not edit" into some other file must not be mistaken
    // for generated output — src/zsh/lib/hook-generator.ts is exactly that, and a raw
    // substring sniff flagged it.
    const haystack = SCRIPT_EXT_RE.test(file)
        ? scanComments(head)
              .map((span) => span.text)
              .join("\n")
        : head;
    const hit = haystack.match(GENERATED_HEADER_RE);
    return hit === null ? null : `header comment says "${hit[0]}"`;
};

const SCRIPT_EXT_RE = /\.(m|c)?(ts|js)x?$/;

/**
 * Did the ops turn parseable source into unparseable source? A post-condition is a
 * substring test and cannot see structure, so a dropped brace passes `expectAfter`
 * and still breaks the file. This catches that before anything is written.
 * Returns the parser message, or null when the file is fine (or was already broken,
 * or is not a script, or Bun's transpiler is unavailable).
 */
const brokeSyntax = (file: string, before: string, after: string): string | null => {
    if (!SCRIPT_EXT_RE.test(file) || before === after) {
        return null;
    }
    const Transpiler = (
        globalThis as { Bun?: { Transpiler?: new (o: { loader: string }) => { scan: (s: string) => unknown } } }
    ).Bun?.Transpiler;
    if (Transpiler === undefined) {
        return null;
    }
    const tp = new Transpiler({ loader: file.endsWith("x") ? "tsx" : "ts" });
    try {
        tp.scan(before);
    } catch {
        return null; // already unparseable before the sweep — not our doing
    }
    try {
        tp.scan(after);
        return null;
    } catch (err) {
        // Bun's BuildMessage carries the position; without the line number the reader
        // has to bisect a 700-line file by hand to find which op broke it.
        const pos = (err as { position?: { line?: number; column?: number; lineText?: string } }).position;
        const where =
            pos?.line === undefined
                ? ""
                : ` at line ${pos.line + 1}${pos.column === undefined ? "" : `:${pos.column + 1}`}${pos.lineText === undefined ? "" : ` → "${pos.lineText.trim().slice(0, 100)}"`}`;
        return `${String(err).split("\n")[0].slice(0, 120)}${where}`;
    }
};

const validateEdit = (edit: FileEdit): string | null => {
    // Presence, not truthiness: createWith "" is a legitimate empty file.
    const creates = edit.createWith !== undefined;
    if (edit.delete && (edit.ops?.length || edit.renameTo || creates)) {
        return "delete:true cannot be combined with ops/renameTo/createWith";
    }
    if (!edit.delete && !edit.ops?.length && !edit.renameTo && !creates) {
        return "edit has no ops, no delete, no renameTo, no createWith — nothing to do";
    }
    return null;
};

/**
 * Execute a batch of file edits.
 *
 * Transactional by default: every file is processed IN MEMORY first; if any
 * required op misses or a post-condition fails, NOTHING is written and the
 * process exits non-zero (or throws with `throwOnFailure`). Pass `partial: true`
 * to write the files that fully passed anyway.
 *
 * `--dry` on argv (or `dryRun: true`) prints diffs and writes nothing.
 */
const KNOWN_RUN_KEYS = [
    "dryRun",
    "backupDir",
    "backupOverwrite",
    "cwd",
    "partial",
    "verbose",
    "showDiff",
    "maxDiffLines",
    "maxTotalDiffLines",
    "allowNodeModules",
    "allowGenerated",
    "syntaxCheck",
    "throwOnFailure",
    "verifyCommand",
    "verifyTimeoutMs",
    "onWritten",
    "leftoversCheck",
];

/** A known key sharing a prefix or a substring with the typo, for the "did you mean" hint. */
const closestRunKey = (typo: string): string | undefined => {
    const lower = typo.toLowerCase();
    return KNOWN_RUN_KEYS.find(
        (k) => k.toLowerCase().startsWith(lower.slice(0, 3)) || lower.includes(k.toLowerCase().slice(0, 4))
    );
};

export const run = async ({ edits, ...opts }: RunParams): Promise<RunReport> => {
    const dryRun = opts.dryRun || process.argv.includes("--dry");
    const verbose = opts.verbose ?? true;
    const throwOnFailure = opts.throwOnFailure ?? true;
    const bail = (message: string, code: 1 | 2 | 3, report?: RunReport): never => {
        if (throwOnFailure) {
            throw new FableReplaceError(message, code, report);
        }
        process.exit(code);
    };
    const cwd = opts.cwd ?? process.cwd();
    const maxDiffLines = opts.maxDiffLines ?? 200;
    // Per-file caps are not enough on a 50-file sweep: the total output overruns any
    // terminal or log you would `tail`, and a truncated tail reads as a finished report.
    let diffBudget = opts.maxTotalDiffLines ?? 2000;
    let diffsSuppressed = 0;

    // Absolute whatever `cwd` is: a relative --cwd used to persist "sub/file.ts" in the
    // manifest, so the printed undo command restored against the caller's directory.
    const resolve = (p: string): string => path.resolve(cwd, p);

    // ── pre-flight validation ──────────────────────────────────────────────
    const preflightErrors: string[] = [];
    // An unknown option is a typo that would otherwise do nothing: `dry: true` instead of
    // `dryRun: true` once nearly turned a preview into a real write.
    for (const key of Object.keys(opts)) {
        if (!KNOWN_RUN_KEYS.includes(key)) {
            const hint = closestRunKey(key);
            preflightErrors.push(
                `unknown option "${key}"${hint ? ` — did you mean "${hint}"?` : ""}. Known: ${KNOWN_RUN_KEYS.join(", ")}`
            );
        }
    }
    const seen = new Set<string>();
    const renameTargets = new Map<string, string>();
    for (const edit of edits) {
        const abs = resolve(edit.file);
        if (seen.has(abs)) {
            preflightErrors.push(
                `${edit.file}: listed twice in one batch — merge the ops into one FileEdit, or wrap the batch in mergeFileEdits()`
            );
        }
        seen.add(abs);
        if (!opts.allowNodeModules && abs.includes(`${path.sep}node_modules${path.sep}`)) {
            preflightErrors.push(
                `${edit.file}: refusing to edit inside node_modules (set allowNodeModules to override)`
            );
        }
        if (opts.allowGenerated !== true && edit.allowGenerated !== true && !edit.delete) {
            const why = looksGenerated(abs);
            if (why !== null) {
                preflightErrors.push(
                    `${edit.file}: refusing to edit a GENERATED file (${why}) — the next codegen run discards the change. Fix the generator, or pass allowGenerated: true.`
                );
            }
        }
        const structural = validateEdit(edit);
        if (structural) {
            preflightErrors.push(`${edit.file}: ${structural}`);
        }
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
            // Reading it threw a bare EISDIR from deep inside the runner.
            preflightErrors.push(`${edit.file}: is a directory, not a file`);
        }
        if (edit.renameTo) {
            const target = resolve(edit.renameTo);
            const claimedBy = renameTargets.get(target);
            if (claimedBy !== undefined) {
                preflightErrors.push(`${edit.file}: renames to ${edit.renameTo}, which ${claimedBy} also claims`);
            }
            renameTargets.set(target, edit.file);
            // The destination is a write to a protected path as much as the source is.
            if (!opts.allowNodeModules && target.includes(`${path.sep}node_modules${path.sep}`)) {
                preflightErrors.push(
                    `${edit.file}: refusing to rename into node_modules (${edit.renameTo}; set allowNodeModules to override)`
                );
            }
            if (opts.allowGenerated !== true && edit.allowGenerated !== true && target !== abs) {
                const why = looksGenerated(target);
                if (why !== null) {
                    preflightErrors.push(
                        `${edit.file}: refusing to rename onto a GENERATED path ${edit.renameTo} (${why}) — pass allowGenerated: true.`
                    );
                }
            }
            if (target !== abs && fs.existsSync(target) && !edit.overwrite) {
                preflightErrors.push(
                    `${edit.file}: renameTo target already exists: ${edit.renameTo} — set overwrite: true to replace it`
                );
            }
        }
    }
    for (const [target, claimedBy] of renameTargets) {
        if (seen.has(target)) {
            preflightErrors.push(`${claimedBy}: renameTo target is also edited in this batch: ${target}`);
        }
    }
    if (opts.backupDir !== undefined && opts.backupOverwrite !== true && !dryRun) {
        const inUse = backupDirInUse(opts.backupDir);
        if (inUse !== null) {
            preflightErrors.push(
                `backupDir ${opts.backupDir} already holds a manifest from ${inUse} — reusing it OVERWRITES that snapshot: the original file content stored there becomes UNRECOVERABLE and a later rollback lands on the intermediate version. If you are RE-RUNNING this sweep, point backupDir at a fresh directory (scratchDir()); a dry run never writes one, so this always means an earlier real run. backupOverwrite: true is a one-way door; pass it only when the old snapshot is worthless.`
            );
        }
    }
    if (opts.verifyCommand !== undefined) {
        const { refusal, warning } = checkVerifyCommand(opts.verifyCommand);
        if (refusal !== undefined) {
            preflightErrors.push(refusal);
        } else if (warning !== undefined) {
            console.error(paint(COLORS.skip, `WARNING: ${warning}`));
        }
    }

    if (dryRun && opts.verifyCommand !== undefined) {
        preflightErrors.push(
            "--dry together with a verify command: a dry run writes nothing, so there is nothing to verify and a green result would be a lie. Drop one of the two."
        );
    }
    if (preflightErrors.length > 0) {
        for (const e of preflightErrors) {
            console.error(paint(COLORS.miss, `PRE-FLIGHT: ${e}`));
        }
        bail(`fable-replace pre-flight failed:\n${preflightErrors.join("\n")}`, 2);
    }

    // ── phase 1: apply everything in memory ────────────────────────────────
    interface Planned {
        edit: FileEdit;
        abs: string;
        result: FileResult;
        before: string | null;
        after: string | null;
        /** The bytes read from disk, so the write phase can prove they are still there. */
        diskBefore: string | null;
    }
    const planned: Planned[] = [];

    for (const edit of edits) {
        const abs = resolve(edit.file);
        const fileResult: FileResult = {
            file: edit.file,
            action: "unchanged",
            ops: [],
            postConditionFailures: [],
            changed: false,
        };

        if (edit.delete) {
            // The bytes at plan time, so the write phase can refuse to delete a file someone
            // changed in between: the same guard an ordinary edit gets.
            let bytesAtPlan: string | null = null;
            if (!fs.existsSync(abs)) {
                fileResult.action = "failed-read";
                fileResult.postConditionFailures.push("delete requested but file does not exist");
            } else {
                fileResult.action = "deleted";
                fileResult.changed = true;
                bytesAtPlan = fs.readFileSync(abs, "utf8");
            }
            planned.push({ edit, abs, result: fileResult, before: null, after: null, diskBefore: bytesAtPlan });
            continue;
        }

        let before: string;
        let diskBefore: string | null = null;
        if (fs.existsSync(abs)) {
            if (edit.createWith !== undefined) {
                // Only the CLI used to refuse this, so a library caller got a silent no-op that
                // reported ok. Both doors share the refusal here.
                fileResult.action = "failed-read";
                fileResult.postConditionFailures.push(
                    'createWith ("<<< create") refuses to overwrite an existing file. Use replace ops on it instead.'
                );
                planned.push({ edit, abs, result: fileResult, before: null, after: null, diskBefore: null });
                continue;
            }

            // Read the BYTES and prove they survive a UTF-8 round trip. readFileSync(…,"utf8")
            // decodes lossily, so one stray cp1252 byte (0x92 in a legacy doc) came back as
            // U+FFFD and was written into the file, changing bytes nowhere near the edit and
            // still reporting OK. A file we cannot represent exactly is a file we must not
            // rewrite at all.
            const raw = fs.readFileSync(abs);
            before = raw.toString("utf8");
            if (!Buffer.from(before, "utf8").equals(raw)) {
                fileResult.action = "failed-read";
                fileResult.postConditionFailures.push(
                    "not valid UTF-8 — refusing to rewrite it, because every invalid byte would silently become U+FFFD. Fix the encoding first (iconv), or edit it with a byte-aware tool."
                );
                planned.push({ edit, abs, result: fileResult, before: null, after: null, diskBefore: null });
                continue;
            }

            diskBefore = before;
        } else if (edit.createWith !== undefined) {
            before = edit.createWith;
            fileResult.action = "created";
        } else {
            fileResult.action = "failed-read";
            fileResult.postConditionFailures.push("file does not exist (use createWith to create)");
            planned.push({ edit, abs, result: fileResult, before: null, after: null, diskBefore: null });
            continue;
        }

        const { content: after, results } = applyOps(before, edit.ops ?? []);
        fileResult.ops = results;
        fileResult.changed = after !== before || fileResult.action === "created" || Boolean(edit.renameTo);
        if (fileResult.action !== "created") {
            fileResult.action = edit.renameTo ? "renamed" : fileResult.changed ? "edited" : "unchanged";
        }

        for (const expected of edit.expectAfter ?? []) {
            if (!after.includes(expected)) {
                fileResult.postConditionFailures.push(`expectAfter not satisfied: "${preview(expected)}"`);
            }
        }
        for (const absent of edit.absentAfter ?? []) {
            if (after.includes(absent)) {
                fileResult.postConditionFailures.push(`absentAfter violated, still present: "${preview(absent)}"`);
            }
        }
        if (opts.syntaxCheck !== false) {
            // A created file has no "before" on disk: its baseline is the empty file, or the
            // check would compare the new content against itself and never run. A rename is
            // checked as its DESTINATION: a .txt renamed to .ts, or a .tsx holding JSX renamed
            // to .ts, must parse under the new loader even when no op touched the bytes.
            const created = fileResult.action === "created";
            const checkPath = edit.renameTo ? resolve(edit.renameTo) : abs;
            const relanguaged = checkPath !== abs && path.extname(checkPath) !== path.extname(abs);
            const broke = brokeSyntax(checkPath, created || relanguaged ? "" : before, after);
            if (broke !== null) {
                fileResult.postConditionFailures.push(
                    created
                        ? `the created content does not parse: ${broke}`
                        : relanguaged
                          ? `does not parse as ${path.extname(checkPath)} at ${edit.renameTo}: ${broke}`
                          : `ops produced unparseable source: ${broke}`
                );
            }
        }

        // A created file's "before" for the diff is the empty file, not its own seed: the
        // dry run must show what lands on disk.
        planned.push({
            edit,
            abs,
            result: fileResult,
            before: fileResult.action === "created" ? "" : before,
            after,
            diskBefore,
        });
    }

    // ── phase 2: report ────────────────────────────────────────────────────
    let missCount = 0;
    for (const plan of planned) {
        const header = `${paint(COLORS.bold, plan.edit.file)} ${paint(COLORS.dim, `(${plan.result.action})`)}`;
        console.log(header);
        for (const op of plan.result.ops) {
            if (op.status === "OK") {
                if (verbose) {
                    const declared = op.expected === undefined ? "" : ` of ${String(op.expected)} declared`;
                    const where =
                        op.lines === undefined || op.lines.length === 0
                            ? ""
                            : ` @ ${op.lines.slice(0, 8).join(",")}${op.lines.length > 8 ? ",…" : ""}`;
                    console.log(
                        `  ${paint(COLORS.ok, "OK  ")} ${op.desc}${op.found !== undefined ? paint(COLORS.dim, ` ×${op.found}${declared}${where}`) : ""}`
                    );
                }
            } else if (op.status === "SKIP") {
                console.log(`  ${paint(COLORS.skip, "SKIP")} ${op.desc} ${paint(COLORS.dim, `— ${op.reason ?? ""}`)}`);
            } else {
                missCount += 1;
                console.log(`  ${paint(COLORS.miss, "MISS")} ${op.desc} ${paint(COLORS.dim, `— ${op.reason ?? ""}`)}`);
            }
        }
        for (const failure of plan.result.postConditionFailures) {
            missCount += 1;
            console.log(`  ${paint(COLORS.miss, "POST")} ${failure}`);
        }
        if (
            (dryRun || opts.showDiff === true) &&
            plan.before !== null &&
            plan.after !== null &&
            plan.before !== plan.after
        ) {
            if (diffBudget > 0) {
                const text = simpleDiff({
                    before: plan.before,
                    after: plan.after,
                    maxLines: Math.min(maxDiffLines, diffBudget),
                });
                diffBudget -= text.split("\n").length;
                console.log(paint(COLORS.dim, text));
            } else {
                diffsSuppressed += 1;
            }
        }
    }

    const failed = missCount > 0;

    // ── phase 3: write (or not) ────────────────────────────────────────────
    const written: string[] = [];
    const touched: string[] = [];
    // A new file is created exclusively and joins `touched` the moment its descriptor
    // exists: a write that fails after creation (ENOSPC) leaves a partial file the recovery
    // must remove, while an EEXIST never adds the foreign path.
    const writeNew = (file: string, text: string): void => {
        const fd = fs.openSync(file, "wx");
        touched.push(file);
        try {
            const data = Buffer.from(text, "utf8");
            let offset = 0;
            while (offset < data.length) {
                offset += fs.writeSync(fd, data, offset, data.length - offset);
            }
        } finally {
            fs.closeSync(fd);
        }
    };
    let leftoverProse = 0;
    let verify: VerifyResult | undefined;
    // The hashes are metadata about a sweep that IS on disk. A failure here (a verify
    // command that turned a tracked path into a directory, a manifest the disk refuses)
    // used to surface as a generic exit 1 with no undo command, as if nothing was written.
    const recordHashesOrBail = (): void => {
        if (opts.backupDir === undefined) {
            return;
        }

        try {
            recordPostWriteHashes(opts.backupDir);
        } catch (err) {
            console.error(
                paint(COLORS.miss, `\nSWEEP WRITTEN, but the backup manifest could not be updated: ${String(err)}`)
            );
            if (verify !== undefined && verify.status !== "pass") {
                printVerifyFailure({ verify, written, backupDir: opts.backupDir });
            } else {
                console.error(`  The ${written.length} file(s) hold the sweep. Undo everything with:`);
                console.error(`  bun "${CLI_PATH}" --rollback "${opts.backupDir}"`);
            }

            bail(
                `fable-replace: sweep WRITTEN, backup manifest not updated (${String(err)}) — ${written.length} file(s) hold the swept content`,
                3,
                {
                    ok: false,
                    files: planned.map((p) => p.result),
                    written,
                    missCount,
                    backupDir: opts.backupDir,
                    verify,
                }
            );
        }
    };
    if (dryRun) {
        if (diffsSuppressed > 0) {
            console.log(
                paint(
                    COLORS.skip,
                    `\n… diffs for ${diffsSuppressed} more file(s) suppressed after the ${opts.maxTotalDiffLines ?? 2000}-line total budget. Raise maxTotalDiffLines, or narrow the batch.`
                )
            );
        }
        console.log(
            paint(
                COLORS.bold,
                `\nDRY RUN — nothing written. ${failed ? `${missCount} MISS(es) to fix.` : "All ops OK."}`
            )
        );
    } else if (failed && !opts.partial) {
        console.log(
            paint(
                COLORS.miss,
                `\nABORTED — ${missCount} MISS(es); transactional mode wrote NOTHING. Fix the ops and re-run.`
            )
        );
    } else {
        const writable = planned.filter(
            (p) =>
                p.result.changed &&
                p.result.ops.every((o) => o.status !== "MISS") &&
                p.result.postConditionFailures.length === 0
        );
        if (opts.backupDir && writable.length > 0) {
            const paths = writable.flatMap((p) => {
                const targets = [p.abs];
                if (p.edit.renameTo) {
                    targets.push(resolve(p.edit.renameTo));
                }
                return targets;
            });
            writeBackup({ dir: opts.backupDir, files: paths, overwrite: opts.backupOverwrite === true });
            console.log(paint(COLORS.dim, `\nBacked up ${paths.length} path(s) to ${opts.backupDir}`));
        }
        try {
            for (const plan of writable) {
                // Everything was read into memory at plan time. If someone else wrote the
                // file in between, overwriting or deleting it now silently destroys their work
                // and still reports OK, so prove the bytes are the ones the plan saw. The
                // refused path never joins `touched`, so the recovery leaves it alone too.
                if (plan.diskBefore !== null && changedOnDisk({ abs: plan.abs, expected: plan.diskBefore })) {
                    throw new Error(
                        `${plan.edit.file} changed on disk after it was read — refusing to ${plan.edit.delete ? "delete" : "overwrite"} someone else's write. Re-run the sweep.`
                    );
                }

                if (plan.edit.delete) {
                    touched.push(plan.abs);
                    fs.rmSync(plan.abs);
                    written.push(`${plan.edit.file} (deleted)`);
                    continue;
                }

                const target = plan.edit.renameTo ? resolve(plan.edit.renameTo) : plan.abs;
                // A rename used to write a fresh 644 file, so a 750 script came back
                // world-readable and no longer executable. Carry the source's mode over.
                const sourceMode = fs.existsSync(plan.abs) ? fs.statSync(plan.abs).mode : undefined;
                fs.mkdirSync(path.dirname(target), { recursive: true });
                // The plan proved a created file and a non-overwriting rename target absent.
                // "wx" proves it again at the write itself: a path that appeared in between,
                // or a dangling symlink existsSync cannot see, fails with EEXIST instead of
                // being truncated, and stays out of `touched`, so the recovery never deletes it.
                const mustBeNew =
                    plan.result.action === "created" || (target !== plan.abs && plan.edit.overwrite !== true);
                if (mustBeNew) {
                    writeNew(target, plan.after ?? "");
                } else {
                    touched.push(target);
                    fs.writeFileSync(target, plan.after ?? "");
                }

                if (target !== plan.abs) {
                    touched.push(plan.abs);
                }
                if (plan.edit.renameTo && target !== plan.abs && fs.existsSync(plan.abs)) {
                    if (sourceMode !== undefined) {
                        fs.chmodSync(target, sourceMode & 0o7777);
                    }

                    fs.rmSync(plan.abs);
                }
                written.push(plan.edit.renameTo ? `${plan.edit.file} → ${plan.edit.renameTo}` : plan.edit.file);
            }
        } catch (err) {
            // An I/O failure (EACCES, ENOSPC, a read-only file) leaves the batch half
            // applied. Transactional means transactional: undo what already landed.
            const notReached = Math.max(0, writable.length - written.length - 1);
            const later = notReached > 0 ? `; ${notReached} later file(s) were never touched` : "";
            console.error(paint(COLORS.miss, `\nWRITE FAILED after ${written.length} file(s): ${String(err)}${later}`));
            const stranded = opts.backupDir ? strandedByRollback({ backupDir: opts.backupDir, touched }) : written;
            if (!opts.backupDir) {
                console.error(
                    paint(COLORS.miss, "no backupDir — the batch is HALF APPLIED. Fix the cause, then re-run.")
                );
            }

            const tail =
                stranded.length > 0
                    ? ` — ${stranded.length} file(s) still hold the swept content: ${stranded.join(", ")}`
                    : "";
            bail(`fable-replace: write failed after ${written.length} file(s): ${String(err)}${later}${tail}`, 1);
        }
        const suffix = failed
            ? paint(COLORS.skip, ` (partial mode: ${missCount} MISS(es) elsewhere — this run still FAILS, exit 1)`)
            : "";
        console.log(paint(COLORS.bold, `\nWrote ${written.length} file(s).`) + suffix);
        if (written.length > 0) {
            recordHashesOrBail();
            opts.onWritten?.({ written, backupDir: opts.backupDir });
        }

        if (opts.verifyCommand !== undefined && written.length > 0) {
            if (failed) {
                // A check against a knowingly half-applied tree only produces noise, and
                // exit 3 must mean everything declared landed.
                console.log(
                    paint(
                        COLORS.skip,
                        `verify skipped: ${missCount} MISS(es) — a check against a partly applied tree proves nothing.`
                    )
                );
            } else {
                console.log(paint(COLORS.dim, `verify: ${opts.verifyCommand}`));
                const result = runVerifyCommand({
                    command: opts.verifyCommand,
                    cwd,
                    backupDir: opts.backupDir,
                    timeoutMs: opts.verifyTimeoutMs,
                });
                verify = result;
                // The check may have rewritten files (a formatter, codegen). The hashes the
                // rollback compares against must describe what is on disk NOW, or the undo
                // command printed on failure refuses with "changed since the sweep".
                recordHashesOrBail();

                if (result.status !== "pass") {
                    printVerifyFailure({ verify: result, written, backupDir: opts.backupDir });
                    const verdict =
                        result.status === "fail"
                            ? `verify failed (exit ${String(result.exitCode)})`
                            : `verify could not be measured (${verifyUnknownReason(result)})`;
                    bail(
                        `fable-replace: sweep WRITTEN, ${verdict} — ${written.length} file(s) hold the swept content`,
                        3,
                        {
                            ok: false,
                            files: planned.map((p) => p.result),
                            written,
                            missCount,
                            backupDir: opts.backupDir,
                            verify: result,
                        }
                    );
                }

                for (const line of result.shown) {
                    console.log(paint(COLORS.dim, `  ${line}`));
                }
            }
        }

        // The MISS path is loud; the OK path used to be inferred from the absence of
        // a MISS line. Say plainly that the sweep landed.
        // A rename is not finished when the code is green. Relying on the caller to
        // remember a post-sweep leftover scan failed in a real trial: the agent ran one,
        // scoped it to src/ only, and shipped three docs naming a symbol it had removed.
        if (opts.leftoversCheck !== undefined && written.length > 0) {
            const { names, dirs } = opts.leftoversCheck;
            const found = leftovers({ names, dirs: dirs ?? [cwd] });
            if (found.docs.length > 0) {
                leftoverProse = found.docs.length;
            }
        }

        if (!failed && leftoverProse === 0) {
            const opsOk = planned.reduce((sum, p) => sum + p.result.ops.filter((o) => o.status === "OK").length, 0);
            const verified = verify !== undefined ? ", verify passed (exit 0)" : "";
            console.log(
                paint(COLORS.ok, `SWEEP COMPLETE: ${written.length} file(s) written, ${opsOk} op(s) OK${verified}.`)
            );
        } else if (!failed) {
            console.error(
                paint(
                    COLORS.miss,
                    `SWEEP INCOMPLETE: the code landed and verified, but ${leftoverProse} prose mention(s) survive. The docs now name something that does not exist. Fix them — do NOT re-run this sweep.`
                )
            );
        }
    }

    const report: RunReport = {
        ok: !failed && leftoverProse === 0,
        files: planned.map((p) => p.result),
        written,
        missCount,
        backupDir: opts.backupDir,
        verify,
    };

    if (failed || leftoverProse > 0) {
        // A dry run with misses is a failed rehearsal: `--dry && real` must not proceed.
        // A partial run with misses wrote the good files but is still not a success.
        const what = dryRun
            ? `fable-replace: dry run has ${missCount} MISS(es)`
            : missCount > 0
              ? `fable-replace: ${missCount} MISS(es) — ${opts.partial ? `partial mode wrote ${written.length} file(s)` : "nothing written"}`
              : `fable-replace: ${leftoverProse} stale prose mention(s) after a green sweep`;
        // Stale prose after a green sweep leaves the code WRITTEN, so it is a 3, like a
        // red verify; exit 1 means nothing (or not everything) landed.
        bail(what, dryRun || missCount > 0 ? 1 : 3, report);
    }

    return report;
};

/**
 * Merge FileEdits that target the same file into one, so two independent sweeps can
 * be concatenated even when their file lists overlap:
 *
 *   run(mergeFileEdits([
 *     ...renameSymbolAcross(filesA, "oldA", "newA"),
 *     ...renameSymbolAcross(filesB, "oldB", "newB"),
 *   ]))
 *
 * Without this, a file appearing in both lists is two FileEdits and pre-flight
 * refuses the batch. Ops are concatenated in order and post-conditions are unioned.
 * Anything that cannot be merged unambiguously (two different `renameTo`, a delete
 * beside ops) throws rather than guessing. Merging is by the exact `file` string.
 */
export const mergeFileEdits = (edits: FileEdit[]): FileEdit[] => {
    const byFile = new Map<string, FileEdit>();
    for (const edit of edits) {
        const existing = byFile.get(edit.file);
        if (existing === undefined) {
            byFile.set(edit.file, { ...edit, ops: [...(edit.ops ?? [])] });
            continue;
        }
        for (const field of ["delete", "renameTo", "createWith"] as const) {
            const a = existing[field];
            const b = edit[field];
            if (a !== undefined && b !== undefined && a !== b) {
                throw new Error(
                    `mergeFileEdits: ${edit.file} has conflicting "${field}" values (${String(a)} vs ${String(b)})`
                );
            }
        }
        if ((existing.delete === true && edit.ops?.length) || (edit.delete === true && existing.ops?.length)) {
            throw new Error(`mergeFileEdits: ${edit.file} is both deleted and edited in the same batch`);
        }
        byFile.set(edit.file, {
            ...existing,
            ...Object.fromEntries(Object.entries(edit).filter(([, v]) => v !== undefined)),
            ops: [...(existing.ops ?? []), ...(edit.ops ?? [])],
            expectAfter: [...(existing.expectAfter ?? []), ...(edit.expectAfter ?? [])],
            absentAfter: [...(existing.absentAfter ?? []), ...(edit.absentAfter ?? [])],
        });
    }
    return [...byFile.values()];
};
