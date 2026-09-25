import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { isTestProcess } from "@genesiscz/utils/test-process";
import {
    type ChangeBytes,
    capBlob,
    commandEditsFiles,
    MAX_BLOB_BYTES,
    readCapped,
    recordFileToolEdit,
    recordScriptedEdits,
    sessionChangesPath,
} from "../../changes/log";
import { gitObjectSink } from "../../changes/objects";
import { type DiffConfig, diffFor, type HooksConfig } from "../config";
import { committedPaths, gitOut, objectId, statusOf } from "../git";
import { hookDiag } from "../log";
import { callDir, safeSegment } from "../paths";
import type { HookPayload } from "../payload";
import { alreadyGone, beforeCopy, leftOutOfCapture } from "./before";
import { claimChange } from "./claim";
import { classifyChange, type DiffCategory } from "./classify";
import { type ChangedFile, changedFiles } from "./collect";
import { namedChanges } from "./named";
import { assembleMessage, type DiffBlock, highlightRange, hunkRange, renderBlock, renderPatch } from "./render";

export interface DiffDecision {
    decision: "emitted" | "silent" | "skip";
    reason: string;
    message?: string;
    files: string[];
}

/**
 * Three sources for the before-state, in falling order of precision:
 * the captured copy, `/dev/null` for a file that did not exist, and `HEAD` for a file
 * that was clean when the command began. Passing a path that does not exist to
 * `--no-index` yields exit 128 and an empty patch, which reads exactly like "no change".
 */
function patchFor(file: ChangedFile, before: string | null, config: DiffConfig, base: string): string {
    const context = `-U${config.contextLines}`;

    if (before) {
        return gitOut(file.root, ["diff", "--no-index", context, "--", before, file.path]);
    }

    if (file.untracked) {
        return gitOut(file.root, ["diff", "--no-index", context, "--", "/dev/null", file.path]);
    }

    // `base` is the HEAD the command STARTED on, not today's HEAD. The two differ exactly
    // when the command committed, and diffing a just-committed file against the commit that
    // created it reports nothing at all.
    return gitOut(file.root, ["diff", base, context, "--", file.path]);
}

/**
 * The rendered block for one changed file, or `null` when the diff turned out empty. A
 * DELETED file always renders: its block is the header alone when git has no patch for it.
 */
function blockFrom(
    file: ChangedFile,
    patch: string,
    hadBefore: boolean,
    config: DiffConfig,
    suppressed: Map<DiffCategory, number>
): DiffBlock | null {
    // The KIND is decided before any rendering work, so a category that is switched off
    // costs one classification rather than a `bat` spawn and a full render.
    const category = classifyChange(file.path, patch, file.root);

    if (!config.categories[category]) {
        suppressed.set(category, (suppressed.get(category) ?? 0) + 1);
        return null;
    }

    const rendered = renderPatch(patch);

    if (rendered.body.length === 0 && !file.deleted) {
        return null;
    }

    const block = renderBlock(file, rendered, hadBefore, category);

    // Highlight only the lines the hunks touch, never the whole file, and only once the
    // budget has decided a context line will really be printed. A deleted file has nothing
    // left on disk to highlight.
    if (!file.deleted) {
        block.colour = () => highlightRange(file.path, hunkRange(patch), config, patch);
    }

    return block;
}

/**
 * Takes the one render of this file state, so two sessions sharing a repository do not both
 * print the same change. A deleted file has no stat of its own, so it keys on its parent
 * directory's mtime with `size: -1`.
 */
function claim(path: string, deleted: boolean, config: DiffConfig, session: string | undefined): boolean {
    if (!config.dedupeAcrossSessions) {
        return true;
    }

    let mtimeMs = 0;
    let size = -1;

    if (deleted) {
        // A fixed key would let the FIRST deletion of a path silence every later one: restore
        // it with `git checkout` (clean, so never rendered, so the claim is never replaced) and
        // delete it again, and the second deletion reads as already rendered. The parent
        // directory's mtime moves on every unlink or create inside it, so each deletion EVENT
        // gets its own key while every session still reads the same value.
        try {
            mtimeMs = statSync(dirname(path)).mtimeMs;
        } catch (err) {
            // The directory went too; the sentinel is the only key left.
            hookDiag("Could not stat a deleted file's directory to claim it", { err, path });
        }
    } else {
        try {
            const stat = statSync(path);

            mtimeMs = stat.mtimeMs;
            size = stat.size;
        } catch (err) {
            // It vanished between the render and here. Claiming a state we cannot read would
            // key on the sentinel and could silence a real deletion later.
            hookDiag("Could not stat a rendered file to claim it", { err, path });
            return true;
        }
    }

    return claimChange({ path, mtimeMs, size }, session);
}

/**
 * Why nothing was printed. Each case needs a different fix, so they read differently.
 *
 * Exported for its tests: the multi-cause string is the whole point of this function and
 * building every combination end to end costs a temp repo per case.
 */
export function silentReason(
    covered: number,
    uncaptured: number,
    claimed: number,
    stale: number,
    suppressed: Map<DiffCategory, number>
): string {
    const kinds = [...suppressed].map(([kind, count]) => `${count} ${kind}`).join(", ");

    // Several causes can hold at once, and each single-cause message below says "every" or
    // names a count as if it were the whole story. Reporting only the first one then states
    // something false: files really were hidden, but they were not the only reason nothing
    // printed, and the reader fixes the wrong thing. So a mix is reported as a mix.
    const causes: Array<[boolean, string]> = [
        [suppressed.size > 0, `a kind this config hides (${kinds})`],
        [covered > 0, `${covered} already rendered natively`],
        [claimed > 0, `${claimed} already rendered`],
        [uncaptured > 0, `${uncaptured} with no captured before-state, over the capture cap`],
        [stale > 0, `${stale} deletion(s) already gone before this command began`],
    ];
    const active = causes.filter(([holds]) => holds);

    if (active.length > 1) {
        return `nothing left to print: ${active.map(([, text]) => text).join("; ")}`;
    }

    if (suppressed.size > 0) {
        return `every changed file was a kind this config hides: ${kinds}`;
    }

    if (covered > 0) {
        return "every changed file was already rendered natively";
    }

    if (claimed > 0) {
        // Not "by another session" any more: a session also dedupes against itself.
        return `${claimed} changed file(s) had already been rendered`;
    }

    if (uncaptured > 0) {
        return `${uncaptured} changed file(s) had no captured before-state, over the capture cap`;
    }

    if (stale > 0) {
        return `${stale} deletion(s) had already happened before this command began`;
    }

    return "no change since this command began";
}

/** What the session change log receives: every file the call captured, before the render cap. */
export type EditRecorder = (payload: HookPayload, captures: CapturedEdit[], since: number) => void;

export interface CapturedEdit {
    path: string;
    /** A copy of the file taken before the command, when one was captured. */
    before: string | null;
    deleted: boolean;
    /**
     * For a TRACKED file with no copy (it was clean when the command began), where its
     * before-state lives in git: the repo root and the commit the command started on.
     */
    gitBase?: { root: string; base: string };
}

/** One captured file's before-state; see `capturedBefores`. */
export function capturedBefore(item: CapturedEdit): ChangeBytes {
    return capturedBefores([item])[0] ?? {};
}

/**
 * The bytes each captured file had before the command, in input order: its copy, or for a clean
 * tracked file the blob at the commit the command started on, capped like `readCapped`. Without
 * either, nothing: a genuinely new file has no before-state.
 *
 * The git blobs are read per repository in TWO processes however many files there are: one
 * `cat-file --batch-check` for the sizes, then one `cat-file --batch` for the blobs small enough to
 * keep. A codemod over N clean files used to start N `git show` processes inside the hook budget.
 */
export function capturedBefores(items: CapturedEdit[]): ChangeBytes[] {
    const results: ChangeBytes[] = items.map((item) => (item.before ? readCapped(item.before) : {}));
    const byRoot = new Map<string, number[]>();

    items.forEach((item, index) => {
        if (!item.before && item.gitBase) {
            byRoot.set(item.gitBase.root, [...(byRoot.get(item.gitBase.root) ?? []), index]);
        }
    });

    for (const [root, indexes] of byRoot) {
        const specs = indexes.map((index) => {
            const item = items[index];
            return `${item?.gitBase?.base}:${relative(root, item?.path ?? "")}`;
        });
        const read = readBlobs(root, specs);

        indexes.forEach((index, at) => {
            results[index] = read[at] ?? {};
        });
    }

    return results;
}

const GIT_BATCH_TIMEOUT_MS = 5_000;
/** One `cat-file --batch` buffers at most this much; a codemod's before-states go in several. */
const GIT_BATCH_BYTES = 64 * 1024 * 1024;
/** Every before-state of ONE command together. Past it the rest get none, not an out-of-memory hook. */
const GIT_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * Groups `wanted` (spec indexes with their sizes, in order) into `cat-file --batch` runs of at most
 * `batchBytes` each, and stops at `totalBytes` overall. A blob larger than a batch runs alone.
 */
export function blobBatches(
    wanted: ReadonlyArray<{ index: number; size: number }>,
    { batchBytes = GIT_BATCH_BYTES, totalBytes = GIT_TOTAL_BYTES } = {}
): { batches: Array<Array<{ index: number; size: number }>>; dropped: number } {
    const batches: Array<Array<{ index: number; size: number }>> = [];
    let current: Array<{ index: number; size: number }> = [];
    let currentBytes = 0;
    let total = 0;

    for (const [at, item] of wanted.entries()) {
        if (total + item.size > totalBytes) {
            if (current.length > 0) {
                batches.push(current);
            }

            return { batches, dropped: wanted.length - at };
        }

        if (current.length > 0 && currentBytes + item.size > batchBytes) {
            batches.push(current);
            current = [];
            currentBytes = 0;
        }

        current.push(item);
        currentBytes += item.size;
        total += item.size;
    }

    if (current.length > 0) {
        batches.push(current);
    }

    return { batches, dropped: 0 };
}

/** `<rev>:<path>` specs of one repository, read through `cat-file`, capped. Never throws. */
function readBlobs(root: string, specs: string[]): ChangeBytes[] {
    const results: ChangeBytes[] = specs.map(() => ({}));
    const check = spawnSync("git", ["-C", root, "cat-file", "--batch-check"], {
        input: `${specs.join("\n")}\n`,
        encoding: "utf8",
        // One line per spec: `<oid> <type> <size>`, or the spec itself followed by `missing`. The
        // 1 MiB default cut off a codemod over ~17k files, and every file lost its before-state.
        maxBuffer: specs.reduce((sum, spec) => sum + Buffer.byteLength(spec) + 128, 0),
        timeout: GIT_BATCH_TIMEOUT_MS,
    });

    if (check.status !== 0) {
        hookDiag("No git before-states for captured files", { root, status: check.status, error: check.error });
        return results;
    }

    // `<oid> <type> <size>` per found spec, `<spec> missing` otherwise, in input order.
    const wanted: Array<{ index: number; size: number }> = [];
    check.stdout
        .split("\n")
        .slice(0, specs.length)
        .forEach((line, index) => {
            const size = Number(line.match(/^[0-9a-f]+ blob (\d+)$/)?.[1]);

            if (!Number.isFinite(size)) {
                return;
            }

            if (size > MAX_BLOB_BYTES) {
                results[index] = { afterSkipped: "large" };
                return;
            }

            wanted.push({ index, size });
        });

    const { batches, dropped } = blobBatches(wanted);

    if (dropped > 0) {
        hookDiag("Too many bytes of git before-states for one command; the rest get none", {
            root,
            dropped,
            totalBytes: GIT_TOTAL_BYTES,
        });
    }

    for (const batch of batches) {
        const read = spawnSync("git", ["-C", root, "cat-file", "--batch"], {
            input: `${batch.map((item) => specs[item.index]).join("\n")}\n`,
            maxBuffer: batch.reduce((sum, item) => sum + item.size + 128, 0),
            timeout: GIT_BATCH_TIMEOUT_MS,
        });

        if (read.status !== 0) {
            hookDiag("No git before-states for captured files", { root, status: read.status, error: read.error });
            return results;
        }

        const out = read.stdout;
        let offset = 0;

        for (const { index } of batch) {
            const newline = out.indexOf(0x0a, offset);

            if (newline === -1) {
                break;
            }

            const size = Number(
                out
                    .subarray(offset, newline)
                    .toString("utf8")
                    .match(/ (\d+)$/)?.[1]
            );

            if (!Number.isFinite(size)) {
                offset = newline + 1;
                continue;
            }

            results[index] = capBlob(Buffer.from(out.subarray(newline + 1, newline + 1 + size)));
            offset = newline + 1 + size + 1;
        }
    }

    return results;
}

export function runDiffPost(
    payload: HookPayload,
    config: HooksConfig,
    record: EditRecorder = recordBashEdits
): DiffDecision {
    const diff = diffFor(config, payload.harness);

    if (!diff.enabled) {
        return { decision: "skip", reason: `diff disabled in config for ${payload.harness}`, files: [] };
    }

    const session = safeSegment(payload.sessionId);
    const call = safeSegment(payload.toolUseId);

    if (session === null || call === null) {
        // The post phase ends in a recursive delete of this directory, so an id that cannot
        // be a path segment must never reach `callDir`.
        return { decision: "skip", reason: "payload carries no usable session or tool call id", files: [] };
    }

    const dir = callDir(payload.harness, session, call);
    const rootsFile = join(dir, "roots.txt");

    if (!existsSync(rootsFile)) {
        return { decision: "skip", reason: "no capture from the pre phase", files: [] };
    }

    const roots = readFileSync(rootsFile, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
    const headsPath = join(dir, "heads.txt");
    const heads = existsSync(headsPath) ? readFileSync(headsPath, "utf8").split("\n") : [];
    const stampPath = join(dir, "stamp");
    const since = existsSync(stampPath) ? Number(readFileSync(stampPath, "utf8").trim()) * 1000 : Date.now() - 20_000;
    // The stand-down is per FILE. The harness emits a payload on every call once the
    // feature is on, and it is empty whenever the change landed outside the cwd repo,
    // so treating its mere presence as "already rendered" silences this exactly where
    // it is needed.
    const native = new Set(diff.standDownWhenNative ? payload.nativeDiffFiles : []);
    const blocks: DiffBlock[] = [];
    const files: string[] = [];
    const captures: CapturedEdit[] = [];
    // The render cap bounds the diff blocks only. A command that edits files keeps scanning
    // past it, so the session change log gets every file it touched; a read-only command
    // still stops at the cap and pays for no extra `git status`.
    const logsEdits = commandEditsFiles(payload.command);
    const full = () => blocks.length >= diff.maxFiles;
    let covered = 0;
    let uncaptured = 0;
    let claimed = 0;
    let stale = 0;
    const suppressed = new Map<DiffCategory, number>();

    roots.forEach((root, index) => {
        // The cap short-circuits the ROOT loop too. Breaking only the inner loop still called
        // `changedFiles` for every remaining root, and that is a `git status` plus an
        // `ls-files` per root, on the hot path, for output already capped away.
        if (full() && !logsEdits) {
            return;
        }

        // ONE status read per root, reused for the entries AND the current HEAD: porcelain
        // v2's `--branch` header already carries the oid, so noticing a commit costs nothing
        // until one has actually happened.
        const summary = statusOf(root);
        const startedOn = objectId(heads[index]?.trim());
        const nowOn = objectId(summary.branch?.oid);
        const moved = startedOn !== null && nowOn !== null && startedOn !== nowOn;
        const base = moved && startedOn ? startedOn : "HEAD";
        const committed = moved && startedOn && nowOn ? committedPaths(root, startedOn, nowOn) : [];
        for (const file of changedFiles(root, since, diff, { entries: summary.entries, committed })) {
            if (full() && !logsEdits) {
                break;
            }

            if (file.deleted && alreadyGone(dir, root, file.path)) {
                // It was already deleted when this command began, so this command did not
                // delete it. A deletion carries no mtime and therefore bypasses the `since`
                // filter every edit passes, which made `git status` reprint it on every
                // later command until someone committed it.
                stale += 1;
                continue;
            }

            const before = file.deleted ? null : beforeCopy(dir, root, file.path);
            // It was already dirty when the command began, and its before-state did not fit the
            // capture budget. The commit is then NOT its before-state: it lacks every earlier
            // uncommitted edit, from this session or another. So the log gets no before-state for
            // it, and the diff says nothing.
            const leftOut = before === null && !file.deleted && leftOutOfCapture(dir, root, file.path);
            // Every changed file reaches the log, a natively rendered one included: the native
            // stand-down below only decides what THIS hook prints.
            captures.push({
                path: file.path,
                before,
                deleted: file.deleted,
                ...(before === null && !file.untracked && !leftOut ? { gitBase: { root, base } } : {}),
            });

            if (full()) {
                continue;
            }

            if (native.has(file.path)) {
                covered += 1;
                continue;
            }

            if (leftOut) {
                uncaptured += 1;
                continue;
            }

            const block = blockFrom(file, patchFor(file, before, diff, base), before !== null, diff, suppressed);

            if (block === null) {
                continue;
            }

            if (!claim(file.path, file.deleted, diff, payload.sessionId)) {
                claimed += 1;
                continue;
            }

            files.push(file.path);
            blocks.push(block);
        }
    });

    // Files the command NAMED rather than worked in. They are read from a copy, so this adds
    // no git process unless one of them actually changed.
    for (const change of namedChanges(dir)) {
        if (full() && !logsEdits) {
            break;
        }

        // A named path inside a captured root was already captured, with its git before-state.
        if (!captures.some((item) => item.path === change.path)) {
            captures.push({ path: change.path, before: change.before, deleted: change.deleted });
        }

        if (full()) {
            continue;
        }

        if (native.has(change.path)) {
            covered += 1;
            continue;
        }

        if (files.includes(change.path)) {
            // Already rendered above: a named path can also sit inside a captured root.
            continue;
        }

        if (change.before === null && !change.deleted && !diff.namedPathsShowCreated) {
            // A file this command created, known only because the command named it. That is
            // a scratch file far more often than not, and the command's own output already
            // says what it wrote. An edit to a file that ALREADY existed still renders.
            continue;
        }

        const file: ChangedFile = {
            path: change.path,
            root: dirname(change.path),
            // "Added" is right only when there was genuinely no before-state.
            untracked: change.before === null,
            deleted: change.deleted,
        };
        // Always `--no-index`, in both directions: a named path may live outside every
        // repository, so `git diff HEAD` is not available to it. A deletion is the copy
        // against `/dev/null`, which is what gives the removed lines.
        const patch = gitOut(file.root, [
            "diff",
            "--no-index",
            `-U${diff.contextLines}`,
            "--",
            change.before ?? "/dev/null",
            change.deleted ? "/dev/null" : change.path,
        ]);
        const block = blockFrom(file, patch, change.before !== null, diff, suppressed);

        if (block === null) {
            continue;
        }

        if (!claim(change.path, change.deleted, diff, payload.sessionId)) {
            claimed += 1;
            continue;
        }

        files.push(change.path);
        blocks.push(block);
    }

    record(payload, captures, since);

    try {
        rmSync(dir, { recursive: true, force: true });
    } catch (err) {
        hookDiag("Could not remove the capture directory", { err, dir });
    }

    if (blocks.length === 0) {
        return { decision: "silent", reason: silentReason(covered, uncaptured, claimed, stale, suppressed), files: [] };
    }

    return {
        decision: "emitted",
        reason: "rendered a diff the harness did not",
        message: assembleMessage(blocks, diff),
        files,
    };
}

function turnOf(payload: HookPayload): string {
    for (const key of ["turnId", "turn_id", "promptId", "prompt_id"]) {
        const value = payload.raw[key];

        if (typeof value === "string" && value.length > 0) {
            return value;
        }
    }

    return payload.toolUseId ?? "unknown";
}

/** The before and after bytes one chunk of `recordBashEdits` may hold at once. */
const RECORD_CHUNK_BYTES = 64 * 1024 * 1024;

function fileSize(path: string): number {
    try {
        return statSync(path).size;
    } catch (err) {
        hookDiag("Could not size a captured file", { err, path });
        return 0;
    }
}

/**
 * The captures in consecutive chunks whose before and after bytes stay under `chunkBytes`, each side
 * counted at most at the blob cap (a larger file is stored as a skip reason, not as bytes). A clean
 * tracked file's before-state is in git; its current size stands in for it. Never an empty list.
 */
export function captureChunks(
    captures: readonly CapturedEdit[],
    { chunkBytes = RECORD_CHUNK_BYTES, size = fileSize }: { chunkBytes?: number; size?: (path: string) => number } = {}
): CapturedEdit[][] {
    const chunks: CapturedEdit[][] = [[]];
    let bytes = 0;

    for (const item of captures) {
        const after = item.deleted ? 0 : Math.min(size(item.path), MAX_BLOB_BYTES);
        const before = item.before ? Math.min(size(item.before), MAX_BLOB_BYTES) : item.gitBase ? after : 0;
        const current = chunks[chunks.length - 1] ?? [];

        if (current.length > 0 && bytes + before + after > chunkBytes) {
            chunks.push([item]);
            bytes = before + after;
            continue;
        }

        current.push(item);
        bytes += before + after;
    }

    return chunks;
}

/**
 * Session log for scripted editors. A codemod can touch thousands of files, so their bytes are read,
 * hashed and dropped one bounded chunk at a time instead of all held at once. Tests never touch the
 * home directory. Never throws.
 */
function recordBashEdits(payload: HookPayload, captures: CapturedEdit[], since: number): void {
    try {
        if (!payload.sessionId || isTestProcess() || !commandEditsFiles(payload.command)) {
            return;
        }

        const file = sessionChangesPath(payload.sessionId);
        const known = new Set(captures.map((item) => item.path));
        const sink = gitObjectSink(undefined, (line) => hookDiag(line));
        const event = {
            provider: payload.harness,
            session: payload.sessionId,
            turn: turnOf(payload),
            tool: payload.tool,
            ...(payload.toolUseId ? { toolUseId: payload.toolUseId } : {}),
            cwd: payload.cwd,
        };

        captureChunks(captures).forEach((chunk, at) => {
            const befores = capturedBefores(chunk);
            const touched = chunk.map((item, index) => {
                const before = befores[index] ?? {};
                const after = item.deleted ? {} : readCapped(item.path);
                return {
                    path: item.path,
                    before: before.after,
                    beforeSkipped: before.afterSkipped,
                    after: after.after,
                    afterSkipped: after.afterSkipped,
                };
            });

            // Paths the command only named are looked up once, and never one it captured.
            recordScriptedEdits(
                file,
                payload.command,
                { ...event, ...(at === 0 ? { since, known } : {}) },
                touched,
                sink
            );
        });
    } catch (err) {
        hookDiag("Could not record the session change", { err });
    }
}

function field(value: unknown, key: string): unknown {
    return typeof value === "object" && value !== null && key in value
        ? (value as Record<string, unknown>)[key]
        : undefined;
}

/**
 * Session log row for an Edit, MultiEdit or Write call. The harness renders these diffs itself,
 * so this only records. Tests never touch the home directory. Never throws.
 */
export function recordFileToolChange(payload: HookPayload): void {
    try {
        if (!payload.sessionId || isTestProcess()) {
            return;
        }

        const path = field(payload.raw.tool_input ?? payload.raw.toolInput, "file_path");
        const original = field(payload.raw.tool_response ?? payload.raw.toolResponse, "originalFile");

        if (typeof path !== "string" || path.length === 0) {
            return;
        }

        recordFileToolEdit(
            sessionChangesPath(payload.sessionId),
            {
                provider: payload.harness,
                session: payload.sessionId,
                turn: turnOf(payload),
                tool: payload.tool,
                ...(payload.toolUseId ? { toolUseId: payload.toolUseId } : {}),
                cwd: payload.cwd,
                path,
            },
            typeof original === "string" || original === null ? original : undefined,
            gitObjectSink(undefined, (line) => hookDiag(line))
        );
    } catch (err) {
        hookDiag("Could not record the file-tool change", { err });
    }
}
