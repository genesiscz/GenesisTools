import { spawnSync } from "node:child_process";
import {
    closeSync,
    existsSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";
import type { StatusEntry } from "@genesiscz/utils/git/porcelain";
import { SafeJSON } from "@genesiscz/utils/json";
import { isTestProcess } from "@genesiscz/utils/test-process";
import { looksLikeCookieJar, redactSecretsInText } from "@genesiscz/utils/transclude/redact";
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
import { committedPaths, gitOut, lastHistoryMove, objectId, statusOf, untrackedFilesIn } from "../git";
import { hookDiag } from "../log";
import { modsPluginDisabled } from "../mods";
import { callDir, safeSegment } from "../paths";
import { type HookPayload, normalizeEvent } from "../payload";
import {
    type Attribution,
    type AttributionContext,
    actorOf,
    attribute,
    gitOperation,
    inFlightRoots,
    othersTouches,
    readOnlyCommand,
    recordTouches,
    summaryLine,
    type Touch,
} from "./attribution";
import { alreadyGone, beforeCopier, beforeCopy, leftOutOfCapture } from "./before";
import { transcriptOf } from "./capture";
import { claimChange } from "./claim";
import { classifyChange, type DiffCategory } from "./classify";
import { type ChangedFile, changedFiles } from "./collect";
import { commandDirs, namedArguments } from "./command-paths";
import { type FullDiffPart, fullDiffLine, overflowPart, writeFullDiff } from "./full";
import { appendMentions, canonical, covers, loadMentions, type Mentions, mentionsFrom, mentionsOf } from "./mentions";
import { namedChanges } from "./named";
import { type DiffBlock, fitMessage, highlightRange, hunkRange, renderBlock, renderPatch, themedDress } from "./render";
import { terminalColumns } from "./terminal";
import { type Palette, resolvePalette } from "./theme";
import { writerChanges } from "./writers";

export interface DiffDecision {
    /** `noted`: no diff block, only the one-line summaries of files it could not show. */
    /** `deferred`: a call that went to the background; its diff is taken when the task ends. */
    decision: "emitted" | "noted" | "silent" | "skip" | "deferred";
    reason: string;
    message?: string;
    files: string[];
    /** Changed files left to another writer, for the decision log. */
    others?: string[];
    /** Why each printed file counted as this call's: named, named folder, mentioned, runner or writer. */
    attributed?: Record<string, string>;
    /** What the message carried, for the decision log and `diff log`. */
    stats?: { chars: number; blocks: number; elided: number; dropped: number; fullDiff?: string };
    /** Set on a background call's diff, taken when its task ended (`flushDeferred`). */
    task?: { id: string; toolUseId: string; command: string };
}

/**
 * Three sources for the before-state, in falling order of precision:
 * the captured copy, `/dev/null` for a file that did not exist, and `HEAD` for a file
 * that was clean when the command began. Passing a path that does not exist to
 * `--no-index` yields exit 128 and an empty patch, which reads exactly like "no change".
 */
function patchFor({
    file,
    before,
    config,
    base,
}: {
    file: ChangedFile;
    before: string | null;
    config: DiffConfig;
    base: string;
}): string {
    const context = `-U${config.contextLines}`;

    if (before) {
        return gitPatch(file.root, ["--no-index", context, "--", before, file.path]);
    }

    if (file.untracked) {
        return gitPatch(file.root, ["--no-index", context, "--", "/dev/null", file.path]);
    }

    // `base` is the HEAD the command STARTED on, not today's HEAD. The two differ exactly
    // when the command committed, and diffing a just-committed file against the commit that
    // created it reports nothing at all.
    return gitPatch(file.root, [base, context, "--", file.path], [baseHead(file, base)]);
}

/**
 * The first 256 KB of the file as `base` holds it: a command that removed a key's BEGIN line from a file with no
 * captured copy leaves a current head that no longer looks like a key. "" for a file absent at `base`, null for a
 * failed read (`blobHead`).
 */
function baseHead(file: ChangedFile, base: string): string | null {
    return blobHead(file.root, `${base}:${relative(file.root, resolve(file.root, file.path))}`);
}

/**
 * The first `HEAD_BYTES` of a `<rev>:<path>` blob, never the whole blob: past the cap the read stops (`maxBuffer`
 * ends git with SIGTERM), so a one-line edit to a large tracked file reads 256 KB more, not the file again. "" for
 * a blob that does not exist, null when git failed otherwise (the patch is then masked as a cookie jar).
 */
export function blobHead(root: string, spec: string): string | null {
    const run = spawnSync("git", ["-C", root, "cat-file", "blob", spec], {
        maxBuffer: HEAD_BYTES,
        timeout: GIT_BATCH_TIMEOUT_MS,
    });
    const capped = run.error && "code" in run.error && run.error.code === "ENOBUFS";

    if (run.status === 0 || capped) {
        return run.stdout.toString("utf8", 0, Math.min(run.stdout.length, HEAD_BYTES));
    }

    if (
        run.status === 128 &&
        /does not exist|exists on disk, but not in|invalid object name/i.test(String(run.stderr))
    ) {
        return "";
    }

    hookDiag("Could not read the head of a file at the base commit; its patch is masked as a cookie jar", {
        root,
        spec,
        status: run.status,
        signal: run.signal,
        error: run.error,
    });
    return null;
}

/** How much of a file `readHead` and `blobHead` read: enough for a storage state's `"cookies"` or a key's BEGIN. */
const HEAD_BYTES = 256 * 1024;

/**
 * `git diff <args>` with every secret-shaped value masked. Every patch the hook shows or saves comes from here,
 * so neither the model, the screen nor the full-diff note gets a token or a login cookie (a re-login rewrote a
 * Playwright storageState, and its note kept the session cookies in plain text, 2026-10-20).
 */
function gitPatch(root: string, args: string[], baseHeads: Array<string | null> = []): string {
    const paths = args.slice(args.indexOf("--") + 1).filter((path) => path !== "/dev/null");
    const heads = [...paths.map((path) => readHead(resolve(root, path))), ...baseHeads];
    const patch = gitOut(root, ["diff", ...args]);

    // A hunk of a key file can show key lines without the BEGIN and END markers the key pattern needs, so a
    // file that holds a private key shows its changed rows, never their text.
    if (heads.some((head) => head !== null && PRIVATE_KEY_FILE.test(head))) {
        return withheldPatch(patch);
    }

    // A file that could not be read is not proven harmless: it is masked as a cookie jar would be.
    return redactSecretsInText(patch, { cookieJar: heads.some((head) => head === null || looksLikeCookieJar(head)) });
}

// The marker on a line of its own, as a key file holds it: a source file that quotes it (a test fixture) is not a key.
const PRIVATE_KEY_FILE = /^-----BEGIN [A-Z ]*PRIVATE KEY-----\r?$/m;

/** The patch with every body row's text replaced: the row count and the +/- shape stay, the content does not. */
export function withheldPatch(patch: string): string {
    return patch
        .split("\n")
        .map((line) => (/^[-+ ]/.test(line) && !/^(\+\+\+|---) /.test(line) ? `${line[0]}[redacted]` : line))
        .join("\n");
}

/**
 * The first 256 KB of a file: enough to find a storage-state file's `"cookies"` or a key's BEGIN line. "" for a file
 * that does not exist (a deleted side), null for one that exists but could not be read, which the caller fails closed on.
 */
export function readHead(path: string): string | null {
    try {
        const fd = openSync(path, "r");
        try {
            const buffer = Buffer.alloc(HEAD_BYTES);
            return buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0));
        } finally {
            closeSync(fd);
        }
    } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return "";
        }

        hookDiag("Could not read the head of a changed file; its patch is masked as a cookie jar", { err, path });
        return null;
    }
}

/**
 * The rendered block for one changed file, or `null` when the diff turned out empty. A
 * DELETED file always renders: its block is the header alone when git has no patch for it.
 */
/** The patch characters the full-diff mod draws per view (`MAX_CHARS` in plugins/genesis-tools-mods/hooks/register.tsx). */
export const MOD_MAX_PATCH_CHARS = 60_000;

/**
 * Columns a band leaves free: Claude Code draws a hook message 6 columns in (under its `⎿`), so a
 * row filled to the full terminal width wraps and leaves an empty band row under every changed row
 * (seen in cmux on 2026-10-14 23:30 with a margin of 2). One more column keeps it clear of the edge.
 */
const BAND_MARGIN = 7;

/**
 * How a themed block names its file: relative inside the session folder, `~/` under home, else
 * whole, with macOS's `/private` dropped from `/tmp` and `/var` because nobody types it.
 */
function displayPath(path: string, cwd: string): string {
    for (const base of new Set([cwd, canonical(cwd)])) {
        if (path.startsWith(`${base}/`)) {
            return path.slice(base.length + 1);
        }
    }

    const home = homedir();

    return path.startsWith(`${home}/`)
        ? `~/${path.slice(home.length + 1)}`
        : path.replace(/^\/private(?=\/(?:tmp|var)\/)/, "");
}

/** A call that began this long before another and never ended was interrupted; its names are stale. */
const SIBLING_WINDOW_MS = 10 * 60_000;

/**
 * The files other calls still in flight name: another agent's call (a subagent beside its parent),
 * or a background call of any agent. Their capture folders sit beside this one until their post
 * phase. Claude Code runs one agent's editing Bash calls one at a time, so another capture of the
 * SAME agent that is not a background call is a denied or interrupted call, never a running one,
 * and a read-only command edits nothing whoever runs it; neither takes a file away.
 */
function siblingNamed({ ownDir, since, actor }: { ownDir: string; since: number; actor: string }): Set<string> {
    const found = new Set<string>();
    const parent = dirname(ownDir);
    let names: string[];

    try {
        names = readdirSync(parent);
    } catch {
        return found;
    }

    for (const name of names) {
        const dir = join(parent, name);

        if (dir === ownDir) {
            continue;
        }

        try {
            const started = Number(readFileSync(join(dir, "started-ms"), "utf8").trim());
            const deferred = existsSync(join(dir, "background.json"));
            const made = SafeJSON.parse(readFileSync(join(dir, "call.json"), "utf8")) as {
                command?: string;
                actor?: string;
            };
            const running =
                deferred || (made.actor !== actor && Number.isFinite(started) && started >= since - SIBLING_WINDOW_MS);

            if (!running || readOnlyCommand(made.command ?? "")) {
                continue;
            }

            for (const line of readFileSync(join(dir, "named.txt"), "utf8").split("\n")) {
                if (line.length > 0) {
                    found.add(line);
                }
            }
        } catch {
            // The call ended between the listing and the read: nothing of its own to leave.
        }
    }

    return found;
}

/**
 * More files than this in one root, and renames are not looked for. The git work is a few spawns of
 * at most `RENAME_ARGS` paths each, whatever the count; the limit bounds the files hashed (a vault
 * folder of 284 notes moved with one `mv` is 568 candidates).
 */
const RENAME_SCAN_LIMIT = 4_000;
const RENAME_ARGS = 400;
/** A file this large is not hashed for pairing: reading it costs more than a moved copy is worth. */
const RENAME_MAX_BYTES = 4 * 1024 * 1024;

function inChunks<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];

    for (let at = 0; at < items.length; at += size) {
        chunks.push(items.slice(at, at + size));
    }

    return chunks;
}

function commonSuffix(first: string, second: string): number {
    const left = first.split("/");
    const right = second.split("/");
    let shared = 0;

    while (
        shared < left.length &&
        shared < right.length &&
        left[left.length - 1 - shared] === right[right.length - 1 - shared]
    ) {
        shared += 1;
    }

    return shared;
}
/**
 * Files past `maxFiles` whose patch still goes into the full diff, as a multiple of `maxFiles`
 * (45 at the default 15). Each costs one `git diff` process in the post hook (7.2 ms p50, 11.3 ms
 * p90 over 60 runs, 2026-10-15), so a `sed -i` over 200 files waited about 1.3 s more. A file past
 * this count is named in the full diff, without its patch.
 */
const OVERFLOW_PATCHES_PER_FILE = 3;

/**
 * Files moved without a change (`git mv`, `mv`): a deleted path whose blob at `base` equals a
 * changed file's content. They printed as a whole-file Deleted block each (2026-10-14: a moved
 * fixtures folder, 18 blocks); now one line names them. Two git spawns, only when a root has both
 * a deletion and another change.
 */
export function renamesIn({
    root,
    base,
    files,
    entries,
    beforeOf,
}: {
    root: string;
    base: string;
    files: ChangedFile[];
    entries: StatusEntry[];
    /**
     * The file's copy from before the call (`beforeCopy`), when it was dirty then. Its blob in `base` lacks the
     * earlier uncommitted edits, so a dirty file moved by `git mv` matched nothing and printed as a whole
     * deletion (2026-10-18: three Swift files of 782, 305 and 218 lines).
     */
    beforeOf?: (absolute: string) => string | null;
}): Array<{
    from: string;
    to: string;
}> {
    const gone = files.filter((file) => file.deleted);

    if (gone.length === 0) {
        return [];
    }

    // From `git status`, not from `files`: `git mv` and `mv` keep the file's old mtime, so the moved
    // copy is older than the call and the mtime filter behind `files` drops it (2026-10-15: the test
    // passed only when the write and the move fell in one second). A folder moved whole is one
    // collapsed `? new-folder/` entry; it is expanded here, past `untrackedExpansionCap`, because the
    // cap bounds what is shown and a rename costs no row.
    const freshPaths = new Set<string>();
    let remaining = RENAME_SCAN_LIMIT - gone.length;
    if (remaining <= 0) {
        return [];
    }

    const addKnown = (path: string): boolean => {
        const normalized = canonical(path);
        if (!freshPaths.has(normalized)) {
            freshPaths.add(normalized);
            remaining--;
        }
        return remaining >= 0;
    };
    for (const file of files) {
        if (!file.deleted && !addKnown(file.path)) {
            return [];
        }
    }
    for (const entry of entries) {
        if (
            ((entry.kind === "untracked" && !entry.path.endsWith("/")) || entry.index === "A") &&
            !addKnown(join(root, entry.path))
        ) {
            return [];
        }
    }

    // Discovery shares one work budget with the known candidates. A stale empty directory costs
    // one slot too, so many vanished directories cannot cause unbounded synchronous git spawns.
    for (const entry of entries) {
        if (entry.kind !== "untracked" || !entry.path.endsWith("/")) {
            continue;
        }
        if (remaining === 0) {
            return [];
        }
        const names = untrackedFilesIn(root, entry.path, remaining + 1);
        if (!names || names.length > remaining) {
            return [];
        }
        remaining -= Math.max(1, names.length);
        for (const name of names) {
            freshPaths.add(canonical(join(root, name)));
        }
    }
    const fresh = [...freshPaths].filter((path) => {
        try {
            return statSync(path).size <= RENAME_MAX_BYTES;
        } catch {
            return false;
        }
    });

    if (fresh.length === 0) {
        return [];
    }

    const blobs = new Map<string, string[]>();
    const copies = gone.flatMap((file) => {
        const copy = beforeOf?.(file.path) ?? null;

        return copy ? [{ file, copy }] : [];
    });
    const fromHead = gone.filter((file) => !copies.some((item) => item.file === file));

    for (const chunk of inChunks(copies, RENAME_ARGS)) {
        const out = gitOut(root, ["hash-object", "--", ...chunk.map((item) => item.copy)], { quiet: true }).split("\n");

        chunk.forEach((item, index) => {
            const hash = out[index]?.trim();

            if (hash) {
                blobs.set(hash, [...(blobs.get(hash) ?? []), item.file.path]);
            }
        });
    }

    for (const chunk of inChunks(fromHead, RENAME_ARGS)) {
        const listing = gitOut(root, ["ls-tree", "-z", base, "--", ...chunk.map((file) => relative(root, file.path))], {
            quiet: true,
        });

        for (const entry of listing.split("\0")) {
            const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(entry);

            if (match?.[1] && match[2]) {
                blobs.set(match[1], [...(blobs.get(match[1]) ?? []), join(root, match[2])]);
            }
        }
    }

    if (blobs.size === 0) {
        return [];
    }

    const hashes: string[] = [];

    for (const chunk of inChunks(fresh, RENAME_ARGS)) {
        const out = gitOut(root, ["hash-object", "--", ...chunk], { quiet: true }).split("\n");

        hashes.push(...chunk.map((_, index) => out[index]?.trim() ?? ""));
    }

    const pairs: Array<{ from: string; to: string }> = [];

    fresh.forEach((path, index) => {
        const candidates = blobs.get(hashes[index] ?? "");

        if (!candidates || candidates.length === 0) {
            return;
        }

        // Files with the same content (empty placeholders, copies) pair with the deletion that shares
        // the most trailing path with the new name, so a folder move keeps each file in its own place.
        const best = candidates.reduce((chosen, candidate) =>
            commonSuffix(candidate, path) > commonSuffix(chosen, path) ? candidate : chosen
        );

        pairs.push({ from: best, to: path });
        candidates.splice(candidates.indexOf(best), 1);
    });

    return pairs;
}

/**
 * A rename this call may announce. A deletion that was already there is `git status` still
 * reporting an earlier `git mv`, and a file another actor owns is not this call's move either.
 * Both used to print "moved unchanged" before those checks ran.
 */
function ownedRename(
    pair: { from: string; to: string },
    options: { dir: string; root: string; context: AttributionContext }
): boolean {
    if (alreadyGone({ dir: options.dir, root: options.root, absolute: pair.from })) {
        return false;
    }

    const fromKind = attribute({ file: pair.from, root: options.root, context: options.context });
    const toKind = attribute({ file: pair.to, root: options.root, context: options.context });

    return fromKind !== "others" && fromKind !== "ambiguous" && toKind !== "others" && toKind !== "ambiguous";
}

/**
 * The note for files that moved unchanged. Two or more files that moved from one folder to one
 * other with their names kept are one entry, `old/ → new/ (284 files)`; a lone file shows both paths.
 */
function renameLine(root: string, pairs: Array<{ from: string; to: string }>): string {
    const prefix = (path: string, shared: number): string => {
        const parts = path.split("/");

        return parts.slice(0, parts.length - shared).join("/") || ".";
    };
    const moves = pairs.map((pair) => {
        const from = relative(root, pair.from);
        const to = relative(root, pair.to);
        const shared = commonSuffix(from, to);

        // A renamed file shares no trailing segment; a moved one shares at least its name.
        return { from, to, key: shared >= 1 ? `${prefix(from, shared)}/ → ${prefix(to, shared)}/` : null };
    });
    const folders = new Map<string, number>();

    for (const move of moves) {
        if (move.key) {
            folders.set(move.key, (folders.get(move.key) ?? 0) + 1);
        }
    }

    const entries: string[] = [];
    const named = new Set<string>();

    for (const move of moves) {
        const count = move.key ? (folders.get(move.key) ?? 0) : 0;

        if (move.key && count >= 2) {
            if (!named.has(move.key)) {
                named.add(move.key);
                entries.push(`${move.key} (${count} files)`);
            }
        } else {
            entries.push(`${move.from} → ${move.to}`);
        }
    }

    const more = entries.length > 3 ? ` and ${entries.length - 3} more` : "";

    return `${pairs.length} file(s) moved unchanged in ${basename(root)}: ${entries.slice(0, 3).join(", ")}${more}`;
}

/**
 * A file in a temp folder that no git work tree holds: a session's scratch (a PR body, a repro
 * script, `bk.json`). 146 such blocks in one day (2026-10-14), none of them the work itself.
 */
function inTempScratch(path: string): boolean {
    const tops = [...new Set([tmpdir(), canonical(tmpdir()), "/tmp", "/private/tmp"])];
    const top = tops.find((root) => path.startsWith(`${root}/`));

    if (!top) {
        return false;
    }

    for (let dir = dirname(path); dir.length > top.length; dir = dirname(dir)) {
        if (existsSync(join(dir, ".git"))) {
            return false;
        }
    }

    return true;
}

/** A call that went to the background, as its post phase left it in `background.json`. */
interface DeferredCall {
    id: string;
    output: string;
    agent?: string;
}

/**
 * The background task a Bash call went to, or `null`. Claude Code's tool response carries only the
 * id (`backgroundTaskId`); the output file is `<tmp>/claude-<uid>/<project>/<session>/tasks/<id>.output`,
 * with `<project>` the folder name of the transcript (Claude Code 2.1.296). `null` when that file is
 * not found, so the call is diffed now, as before, rather than deferred with no way to see it end.
 */
function backgroundTaskOf(payload: HookPayload): DeferredCall | null {
    const response = payload.raw.tool_response ?? payload.raw.toolResponse;
    const id =
        typeof response === "object" && response !== null && "backgroundTaskId" in response
            ? response.backgroundTaskId
            : undefined;
    const transcript = transcriptOf(payload);

    if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id) || !transcript || !payload.sessionId) {
        return null;
    }

    const folder = join(`claude-${process.getuid?.() ?? 0}`, basename(dirname(transcript)), payload.sessionId, "tasks");
    const agent = payload.raw.agent_id ?? payload.raw.agentId;

    for (const base of new Set(["/private/tmp", "/tmp", tmpdir()])) {
        const output = join(base, folder, `${id}.output`);

        if (existsSync(output)) {
            return { id, output, ...(typeof agent === "string" ? { agent } : {}) };
        }
    }

    return null;
}

/** Whether a background task is over: its output file ends with `[exited with code N]`, or is gone. */
function taskEnded(output: string): boolean {
    let tail: string;

    try {
        const fd = openSync(output, "r");

        try {
            const size = statSync(output).size;
            const buffer = Buffer.alloc(Math.min(size, 120));
            readSync(fd, buffer, 0, buffer.length, size - buffer.length);
            tail = buffer.toString("utf8");
        } finally {
            closeSync(fd);
        }
    } catch (err) {
        return (err as NodeJS.ErrnoException)?.code === "ENOENT";
    }

    return /\[exited with code -?\d+\]\s*$/.test(tail);
}

/**
 * Room a deferred task needs past its heading once the phase has printed something: enough for a
 * summary or the full-diff line (`Full diff: <path>`, about 90 characters).
 */
const DEFERRED_MIN_ROOM = 200;

/**
 * The line `hook-diff-post` prints above a background task's diff. Its length is part of the budget. A command
 * cut short ends in `…`, so a chain like `mkdir … && mv … ; node login.mjs` does not read as if its first
 * 80 characters made the change (2026-10-20).
 */
export function deferredTaskHeading(task: { id: string; command: string }): string {
    // Masked whole before the cut: a token cut in half no longer matches its pattern.
    const [line = "", ...rest] = redactSecretsInText(task.command).split("\n");
    const first = line.length > 80 ? `${line.slice(0, 79)}…` : rest.length > 0 ? `${line}…` : line;

    return `background task ${task.id} ended (${first}):\n`;
}

function linkThatFits(decision: DiffDecision, room: number): string | undefined {
    const path = decision.stats?.fullDiff;

    if (!path || room <= 0) {
        return undefined;
    }

    const line = `Full diff: ${path}`;

    return line.length <= room ? line : undefined;
}

/**
 * The decision whose message fits `room`. A message that does not fit becomes the full-diff line
 * when that line fits, and is omitted when nothing does. The decision itself stays, so the log
 * still names the files.
 */
function fitDecision(decision: DiffDecision, room: number | undefined): DiffDecision {
    if (room === undefined || decision.message === undefined || decision.message.length <= room) {
        return decision;
    }

    const message = linkThatFits(decision, room);
    const stats = decision.stats ? { ...decision.stats, chars: message?.length ?? 0 } : undefined;

    return { ...decision, message, ...(stats ? { stats } : {}) };
}

/** The most characters of one command line that `commandLines` shows, the "…" included. */
const COMMAND_CHARS = 80;

/**
 * The dim lines above a call's own message: the first `count` lines of its command, each cut to
 * `COMMAND_CHARS`, then how many lines were left out (`diff.commandLines`; 0 shows none). Claude Code
 * folds a finished call into "ran N shell commands" and leaves only the hook message under the fold,
 * so without them nothing says which command changed the files.
 */
export function commandLines(command: string, count: number): string {
    // Masked whole before the cut, as `deferredTaskHeading` does: `TOKEN=ghp_… cmd` must not print its token.
    const lines = redactSecretsInText(command)
        .trim()
        .split("\n")
        .map((line) => line.replace(/\p{Cc}/gu, " ").trimEnd());

    if (count <= 0 || !lines[0]) {
        return "";
    }

    const shown = lines.slice(0, count).map((line) => {
        const chars = [...line];

        return chars.length > COMMAND_CHARS ? `${chars.slice(0, COMMAND_CHARS - 1).join("")}…` : line;
    });
    const left = lines.length - shown.length;
    const rows = [
        `$ ${shown[0]}`,
        ...shown.slice(1).map((line) => `  ${line}`),
        ...(left > 0 ? [`  … ${left} more line(s)`] : []),
    ];

    return rows.map((row) => `\u001b[2m${row}\u001b[0m`).join("\n");
}

/** Headings plus messages, in the order `composePostDiff` joins them after the call's own diff. */
export function deferredMessageParts(flushed: DiffDecision[]): string[] {
    return flushed.flatMap((item) =>
        item.message && item.task ? [`${deferredTaskHeading(item.task)}${item.message}`] : []
    );
}

/**
 * Set by the full-diff mod, on every turn, to the id of the session it runs in (`MODS_SESSION_VAR` in
 * plugins/genesis-tools-mods/hooks/register.tsx; the two names must stay equal). Claude Code passes a mod's
 * `env.set` to the hooks of that session (probed 2026-10-22: the PostToolUse hook read the mod's value, equal to
 * the payload's `session_id`). The settings file only says the mod is installed; a session started before
 * `mods watch` has not loaded it, and its diffs would be drawn by no one.
 */
export const MODS_SESSION_VAR = "GENESIS_TOOLS_MODS_SESSION";

/** Whether the mod announced itself in this very session: a nested session inherits another session's id. */
export function modLoadedIn({ sessionId, announced }: { sessionId?: string; announced?: string }): boolean {
    return sessionId !== undefined && sessionId !== "" && announced === sessionId;
}

/** The mod's mark and the real Claude settings, never read by a test (they would make the message depend on this machine). */
function installedMod(sessionId: string | undefined): boolean {
    // The mark is the proof the mod is loaded here, from any scope or `--plugin-dir`. The settings are read only for
    // a marked session, and only an explicit off (a disable this session has not reloaded yet) overrides the mark.
    return (
        !isTestProcess() &&
        modLoadedIn({ sessionId, announced: env.getProcessEnv()[MODS_SESSION_VAR] }) &&
        !modsPluginDisabled()
    );
}

/**
 * Claude Code with the full-diff mod (`genesis-tools-mods`) loaded in this session and `mods.diff.fullDiff` on: the mod
 * draws each call's diff from its note, so the hook's own message would draw it twice. Codex and Grok have no mods.
 */
export function modDrawsDiffs({
    config,
    harness,
    sessionId,
    isEnabled = installedMod,
}: {
    config: HooksConfig;
    harness: string;
    sessionId?: string;
    isEnabled?: (sessionId: string | undefined) => boolean;
}): boolean {
    return (
        harness === "claude" &&
        config.mods.diff.fullDiff &&
        diffFor(config, harness).fullDiff !== "off" &&
        isEnabled(sessionId)
    );
}

/**
 * One post phase: background tasks that have ended share half of the message, and this call gets
 * what remains. The sum, headings included, stays inside `maxMessageChars`. Claude Code replaces
 * a longer `systemMessage` with "Output too large". The call's own diff comes first and each task
 * follows under its heading, so `diff log` can tell which blocks are whose (`readMessage`).
 */
export function composePostDiff({
    payload,
    config,
    record,
}: {
    payload: HookPayload;
    config: HooksConfig;
    record?: EditRecorder;
}): { flushed: DiffDecision[]; decision: DiffDecision; message: string } {
    const maxChars = diffFor(config, payload.harness).maxMessageChars;
    const flushed = flushDeferred({ payload, config, record, maxChars: Math.floor(maxChars / 2) });
    const flushedParts = deferredMessageParts(flushed);
    // `+ 2` per part is the `\n\n` between parts, including the one after this call's own diff.
    const flushedChars = flushedParts.reduce((total, part) => total + part.length + 2, 0);
    const heading = commandLines(payload.command, diffFor(config, payload.harness).commandLines);
    const room = Math.max(0, maxChars - flushedChars - (heading ? heading.length + 1 : 0));
    const drawnByMod = modDrawsDiffs({ config, harness: payload.harness, sessionId: payload.sessionId });
    const decision = fitDecision(runDiffPost({ payload, config, record, maxChars: room, drawnByMod }), room);
    const own = decision.message ? [heading ? `${heading}\n${decision.message}` : decision.message] : [];
    const message = [...own, ...flushedParts].join("\n\n");

    return { flushed, decision, message };
}

/**
 * The diffs of this session's background calls whose task has ended, each taken now through the
 * same `runDiffPost`, so the claim store still keeps a file a later call printed from printing
 * twice. Runs at every post phase of the session: a parent directory listing and one small read
 * per deferred call. `background.json` is renamed before the diff, so of two post phases running
 * at once only one takes it.
 *
 * `maxChars`, when set, is ONE budget for every task, headings included. Each call used to receive
 * the whole budget, so three ended tasks printed three times the ceiling.
 */
export function flushDeferred({
    payload,
    config,
    record,
    maxChars,
}: {
    payload: HookPayload;
    config: HooksConfig;
    record?: EditRecorder;
    maxChars?: number;
}): DiffDecision[] {
    const session = safeSegment(payload.sessionId);
    const call = safeSegment(payload.toolUseId);

    if (session === null || call === null) {
        return [];
    }

    const parent = dirname(callDir(payload.harness, session, call));
    const decisions: DiffDecision[] = [];
    let spent = 0;
    let names: string[];

    try {
        names = readdirSync(parent);
    } catch {
        return [];
    }

    for (const name of names) {
        const dir = join(parent, name);
        let deferred: DeferredCall;
        let made: { command: string; cwd: string; event: string };

        try {
            deferred = SafeJSON.parse(readFileSync(join(dir, "background.json"), "utf8")) as DeferredCall;
            made = SafeJSON.parse(readFileSync(join(dir, "call.json"), "utf8")) as typeof made;
        } catch {
            continue;
        }

        if (!taskEnded(deferred.output)) {
            continue;
        }

        const task = { id: deferred.id, toolUseId: name, command: made.command };
        const heading = deferredTaskHeading(task);
        const gap = maxChars !== undefined && decisions.some((item) => item.message) ? 2 : 0;
        const room = maxChars === undefined ? undefined : Math.max(0, maxChars - spent - gap - heading.length);

        // Taking a task claims its files and removes its capture, so a task whose message can no
        // longer fit would be lost. It stays for the next post phase. The first task of a phase is
        // always taken, so a heading longer than the budget cannot hold a task back for ever.
        if (room !== undefined && spent > 0 && room < DEFERRED_MIN_ROOM) {
            break;
        }

        try {
            renameSync(join(dir, "background.json"), join(dir, "background.taken"));
        } catch {
            continue;
        }
        const decision = fitDecision(
            runDiffPost({
                payload: {
                    ...payload,
                    toolUseId: name,
                    command: made.command,
                    cwd: made.cwd,
                    event: made.event,
                    nativeDiffFiles: [],
                    raw: {
                        transcript_path: transcriptOf(payload),
                        ...(deferred.agent ? { agent_id: deferred.agent } : {}),
                    },
                },
                config,
                record,
                maxChars: room,
                deferred: true,
            }),
            room
        );

        if (maxChars !== undefined && decision.message) {
            spent += gap + heading.length + decision.message.length;
        }

        decisions.push({ ...decision, task });
    }

    return decisions;
}

/** A Claude theme in force for this call: its palette, the folder labels are relative to, the row width. */
interface Look {
    palette: Palette;
    cwd: string;
    /** Columns a row may use, or 0 when the terminal is unknown. */
    width: number;
}

function lookWidth(diff: DiffConfig): number {
    const columns = diff.columns === "auto" ? terminalColumns() : diff.columns;

    return columns === null || columns === 0 ? 0 : Math.max(0, columns - BAND_MARGIN);
}

function blockFrom({
    file,
    patch,
    hadBefore,
    config,
    suppressed,
    look,
}: {
    file: ChangedFile;
    patch: string;
    hadBefore: boolean;
    config: DiffConfig;
    suppressed: Map<DiffCategory, number>;
    look: Look | null;
}): DiffBlock | null {
    // The KIND is decided before any rendering work, so a category that is switched off
    // costs one classification rather than a `bat` spawn and a full render.
    const category = classifyChange({ path: file.path, patch, root: file.root });

    if (!config.categories[category]) {
        suppressed.set(category, (suppressed.get(category) ?? 0) + 1);
        return null;
    }

    const rendered = renderPatch(patch, look?.palette ?? null);
    // A regenerated ledger printed 30 lines of +12,459 -6,099 churn (2026-10-14): past this size a
    // block is its header only, and the message links the full diff.
    const oversized = rendered.added + rendered.removed > config.maxBlockLines;

    if (rendered.body.length === 0 && !file.deleted) {
        return null;
    }

    const hidden = oversized ? rendered.body.length : 0;

    if (oversized) {
        rendered.body = [];
    }

    const label = look ? displayPath(file.path, look.cwd) : file.path;
    const block = renderBlock({ file, patch: rendered, hadBefore, category, label, width: look?.width ?? 0 });

    block.source = { label: `${label} (+${rendered.added} -${rendered.removed})`, patch };

    if (hidden > 0) {
        block.hidden = hidden;
    }

    if (look) {
        block.dress = themedDress({ palette: look.palette, path: file.path, width: look.width });
        return block;
    }

    // Highlight only the lines the hunks touch, never the whole file, and only once the
    // budget has decided a context line will really be printed. A deleted file has nothing
    // left on disk to highlight.
    if (!file.deleted) {
        block.colour = () => highlightRange({ path: file.path, range: hunkRange(patch), config, patch });
    }

    return block;
}

/**
 * Takes the one render of this file state, so two sessions sharing a repository do not both
 * print the same change. A deleted file has no stat of its own, so it keys on its parent
 * directory's mtime with `size: -1`.
 */
function claim({
    path,
    deleted,
    config,
    session,
}: {
    path: string;
    deleted: boolean;
    config: DiffConfig;
    session: string | undefined;
}): boolean {
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
export function silentReason({
    covered,
    uncaptured,
    claimed,
    stale,
    suppressed,
    unattributed = 0,
}: {
    covered: number;
    uncaptured: number;
    claimed: number;
    stale: number;
    suppressed: Map<DiffCategory, number>;
    unattributed?: number;
}): string {
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
        [unattributed > 0, `${unattributed} changed by another writer, not this session`],
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

    if (unattributed > 0) {
        return `${unattributed} changed file(s) were not attributable to this session`;
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

export function runDiffPost({
    payload,
    config,
    record = recordBashEdits,
    maxChars,
    drawnByMod = false,
    deferred = false,
}: {
    payload: HookPayload;
    config: HooksConfig;
    record?: EditRecorder;
    /** The message budget when it must share the hook's one message (`flushDeferred`); else `diff.maxMessageChars`. */
    maxChars?: number;
    /** A background call's diff taken when its task ended (`flushDeferred`): its note is one the mod does not draw. */
    deferred?: boolean;
    /**
     * The full-diff mod draws this call's diff (`modDrawsDiffs`): every diff goes to its note, and the message
     * keeps only the notes under it, so the diff is not drawn twice.
     */
    drawnByMod?: boolean;
}): DiffDecision {
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

    // A backgrounded call's post phase runs when it STARTS, so its edits came later and printed under
    // an unrelated call, or never (504 such calls in a day). Its capture is kept, and `flushDeferred`
    // takes the diff once the task's output file says it exited.
    const task = backgroundTaskOf(payload);

    if (task && existsSync(join(dir, "call.json"))) {
        writeFileSync(join(dir, "background.json"), SafeJSON.stringify(task), { mode: 0o600 });
        return {
            decision: "deferred",
            reason: `the call went to the background (task ${task.id}); its diff is taken when the task ends`,
            files: [],
        };
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
    const attributed: Record<string, string> = {};
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
    const attribution = attributionContext({ payload, since, dir });
    let operation: string | null | undefined;
    const operationOf = (): string | null => {
        operation ??= gitOperation(payload.command);
        return operation;
    };
    // Resolved once and only for a call that renders: `claude` reads Claude Code's settings file.
    let look: Look | null | undefined;
    const lookOf = (): Look | null => {
        if (look === undefined) {
            const palette = resolvePalette(diff.theme);
            look = palette ? { palette, cwd: payload.cwd, width: lookWidth(diff) } : null;
        }

        return look;
    };
    const touches: Touch[] = [];
    const historyNotes: string[] = [];
    const renameNotes: string[] = [];
    const unattributed: Array<{ path: string; root: string }> = [];
    // Changed files the root pass reached after `maxFiles` blocks: named in a note. Their patches
    // go in the full diff; the message still stops at the cap. The capture directory is removed
    // before that file is written, so the patch is taken while the before-state is still on disk.
    const notShown: string[] = [];
    const overflow: FullDiffPart[] = [];
    const overflowRoom = () => overflow.length < diff.maxFiles * OVERFLOW_PATCHES_PER_FILE;
    const uncapturedFiles: Array<{ path: string; root: string }> = [];
    const touch = (path: string, kind: Attribution) =>
        touches.push({ session: actorOf(payload), start: since, end: attribution.now, kind, path });

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
        // A commit is the command's own edit; a rebase, pull, merge, checkout or reset is HEAD
        // walking through other people's work, so the files it brought are named in one line and
        // never rendered. Only commits made AFTER the last such move belong to the command.
        const move = moved && startedOn ? lastHistoryMove(root, since, startedOn) : null;
        const from = move ? move.head : startedOn;
        const base = moved && from ? from : "HEAD";
        const committed = moved && from && nowOn && from !== nowOn ? committedPaths(root, from, nowOn) : [];

        // Once per move: a parallel call of the same session saw the same move and printed it again.
        if (
            move &&
            startedOn &&
            nowOn &&
            claimChange({ path: `${root}#HEAD ${startedOn}..${nowOn}`, mtimeMs: 0, size: 0 }, payload.sessionId)
        ) {
            const carried = committedPaths(root, startedOn, nowOn).length;

            historyNotes.push(
                `git ${move.verb} moved HEAD in ${basename(root)} (${startedOn.slice(0, 7)} to ${nowOn.slice(0, 7)}): ${carried} file(s) came with it, no diff shown`
            );
        }

        const changed = changedFiles({ root, since, config: diff, source: { entries: summary.entries, committed } });
        const renames = renamesIn({
            root,
            base,
            files: changed,
            entries: summary.entries,
            beforeOf: beforeCopier({ dir, root }),
        }).filter((pair) => ownedRename(pair, { dir, root, context: attribution }));
        const renamed = new Set(renames.flatMap((pair) => [pair.from, pair.to]));
        const carried: string[] = [];
        const ownCommits = new Set(committed.map((name) => join(root, name)));

        if (renames.length > 0) {
            renameNotes.push(renameLine(root, renames));
        }

        for (const file of changed) {
            if (full() && !logsEdits) {
                break;
            }

            if (file.deleted && alreadyGone({ dir, root, absolute: file.path })) {
                // It was already deleted when this command began, so this command did not
                // delete it. A deletion carries no mtime and therefore bypasses the `since`
                // filter every edit passes, which made `git status` reprint it on every
                // later command until someone committed it.
                stale += 1;
                continue;
            }

            if (renamed.has(file.path)) {
                continue;
            }

            // Before any copy is read: a change another session made is neither rendered, nor
            // claimed (which would steal that session's render), nor logged as this session's.
            const kind = attribute({ file: file.path, root, context: attribution });

            // A rebase that stopped, a cherry-pick, a stash pop: what git wrote is not the command's
            // edit. Only a file the command names itself still renders (`git checkout -- a.ts`).
            // A commit made after the move is the command's own (`git rebase master && git commit`).
            if (
                kind !== "named" &&
                kind !== "others" &&
                kind !== "ambiguous" &&
                !ownCommits.has(file.path) &&
                operationOf()
            ) {
                carried.push(file.path);
                continue;
            }

            // A read-only command's "others" is no claim at all, so it leaves no row.
            if (kind !== "others") {
                touch(file.path, kind);
            }

            if (kind === "others" || kind === "ambiguous") {
                unattributed.push({ path: file.path, root });
                continue;
            }

            const before = file.deleted ? null : beforeCopy({ dir, root, absolute: file.path });
            // It was already dirty when the command began, and its before-state did not fit the
            // capture budget. The commit is then NOT its before-state: it lacks every earlier
            // uncommitted edit, from this session or another. So the log gets no before-state for
            // it, and the diff says nothing.
            const leftOut = before === null && !file.deleted && leftOutOfCapture({ dir, root, absolute: file.path });
            // Every changed file reaches the log, a natively rendered one included: the native
            // stand-down below only decides what THIS hook prints.
            captures.push({
                path: file.path,
                before,
                deleted: file.deleted,
                ...(before === null && !file.untracked && !leftOut ? { gitBase: { root, base } } : {}),
            });

            if (full()) {
                if (leftOut) {
                    // No before-state was captured: a patch against HEAD or /dev/null would pass the
                    // file's earlier uncommitted edits off as this call's.
                    uncaptured += 1;
                    uncapturedFiles.push({ path: file.path, root });
                    continue;
                }

                notShown.push(file.path);

                if (overflowRoom()) {
                    const patch = patchFor({ file, before, config: diff, base });

                    if (patch.trim().length > 0) {
                        overflow.push(overflowPart(file.path, patch));
                    }
                }

                continue;
            }

            if (native.has(file.path)) {
                covered += 1;
                continue;
            }

            if (leftOut) {
                uncaptured += 1;
                uncapturedFiles.push({ path: file.path, root });
                continue;
            }

            const block = blockFrom({
                file,
                patch: patchFor({ file, before, config: diff, base }),
                hadBefore: before !== null,
                config: diff,
                suppressed,
                look: lookOf(),
            });

            if (block === null) {
                continue;
            }

            if (!claim({ path: file.path, deleted: file.deleted, config: diff, session: payload.sessionId })) {
                claimed += 1;
                continue;
            }

            files.push(file.path);
            attributed[file.path] =
                kind === "named" && !covers({ mentions: attribution.named, file: file.path, root, reach: "file" })
                    ? "named folder"
                    : kind;
            blocks.push(block);
        }

        if (carried.length > 0) {
            historyNotes.push(
                `${carried.length} file(s) changed by git ${operationOf()} in ${basename(root)}, no diff shown`
            );
        }
    });

    // Files the command NAMED rather than worked in. They are read from a copy, so this adds
    // no git process unless one of them actually changed.
    // Files a writer that keeps its own before-copies reported (fable-replace's journal), whatever
    // the command looked like: the paths of a sweep sit in a heredoc spec or behind variables.
    // A path both sources hold keeps the named copy: it was taken at command start, so it also
    // carries an edit the command made before the writer ran.
    // Canonical, like every root path, which comes from `git rev-parse` and is therefore real. A
    // command that names `/tmp/x` and works in the repository git calls `/private/tmp/x` printed
    // the same file twice in one message: 84 messages in the 24 hours to 2026-10-14 22:59.
    const named = namedChanges(dir).map((change) => ({ ...change, path: canonical(change.path) }));
    const namedPaths = new Set(named.map((change) => change.path));
    const startedPath = join(dir, "started-ms");
    const started = existsSync(startedPath) ? Number(readFileSync(startedPath, "utf8").trim()) : Number.NaN;
    const reported = writerChanges({
        since: Number.isFinite(started) ? started : since,
        now: attribution.now,
        sessionId: payload.sessionId,
    }).map((change) => ({ ...change, path: canonical(change.path) }));
    const reportedPaths = new Set(reported.map((change) => change.path));

    for (const change of [...named, ...reported.filter((item) => !namedPaths.has(item.path))]) {
        if (full() && !logsEdits) {
            break;
        }

        // The same attribution as the root pass: a read-only command changed nothing it named (`cat
        // /repo/a.ts` while another session edits it), and a path the root pass gave to another session
        // stays theirs. Neither is captured, claimed, logged or rendered as this session's.
        if (attribution.readOnly() || unattributed.some((item) => item.path === change.path)) {
            if (!unattributed.some((item) => item.path === change.path)) {
                unattributed.push({ path: change.path, root: dirname(change.path) });
            }

            continue;
        }

        // A named path inside a captured root was already captured, with its git before-state.
        if (!captures.some((item) => item.path === change.path)) {
            captures.push({ path: change.path, before: change.before, deleted: change.deleted });
            touch(change.path, "named");
        }

        if (native.has(change.path)) {
            covered += 1;
            continue;
        }

        if (files.includes(change.path)) {
            // Already rendered above: a named path can also sit inside a captured root.
            continue;
        }

        if (!diff.showTempScratch && inTempScratch(change.path)) {
            continue;
        }

        if (
            change.before === null &&
            !change.deleted &&
            !diff.namedPathsShowCreated &&
            !reportedPaths.has(change.path)
        ) {
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
        if (full() && !overflowRoom()) {
            if (!notShown.includes(change.path)) {
                notShown.push(change.path);
            }

            continue;
        }

        // Always `--no-index`, in both directions: a named path may live outside every
        // repository, so `git diff HEAD` is not available to it. A deletion is the copy
        // against `/dev/null`, which is what gives the removed lines.
        const patch = gitPatch(file.root, [
            "--no-index",
            `-U${diff.contextLines}`,
            "--",
            change.before ?? "/dev/null",
            change.deleted ? "/dev/null" : change.path,
        ]);

        if (full()) {
            if (patch.trim().length > 0 && !overflow.some((part) => part.path === change.path)) {
                overflow.push(overflowPart(change.path, patch));
            }

            if (!notShown.includes(change.path) && !files.includes(change.path)) {
                notShown.push(change.path);
            }

            continue;
        }

        const block = blockFrom({
            file,
            patch,
            hadBefore: change.before !== null,
            config: diff,
            suppressed,
            look: lookOf(),
        });

        if (block === null) {
            continue;
        }

        if (!claim({ path: change.path, deleted: change.deleted, config: diff, session: payload.sessionId })) {
            claimed += 1;
            continue;
        }

        files.push(change.path);
        attributed[change.path] = namedPaths.has(change.path) ? "named" : "writer";
        blocks.push(block);
    }

    record(payload, captures, since);
    recordTouches(touches);

    try {
        rmSync(dir, { recursive: true, force: true });
    } catch (err) {
        hookDiag("Could not remove the capture directory", { err, dir });
    }

    // Another writer's change is worth a line only when it is news: not after a command that only
    // read (34 of 107 such lines followed a `tail` or `cat`), and not for a log that something appends to.
    const othersWorthALine = attribution.readOnly()
        ? []
        : unattributed.filter((item) => {
              const kind = classifyChange({ path: item.path, patch: "", root: item.root });
              return kind !== "log" && kind !== "generated";
          });
    const notes = [
        ...historyNotes,
        ...renameNotes,
        ...(uncapturedFiles.length > 0
            ? [summaryLine({ label: "dirty file(s) changed with no captured before-state", files: uncapturedFiles })]
            : []),
        ...(othersWorthALine.length > 0 && diff.othersSummary === "line"
            ? [summaryLine({ label: "file(s) changed by others in this root", files: othersWorthALine })]
            : []),
        ...(notShown.length > 0 ? [`${notShown.length} more changed file(s) past diff.maxFiles ${diff.maxFiles}`] : []),
        ...(blocks.length > 0 && normalizeEvent(payload.event) === "posttoolusefailure"
            ? ["the command failed: this is what it changed before it stopped"]
            : []),
    ];
    const others = unattributed.map((item) => item.path);

    if (blocks.length === 0) {
        const reason = silentReason({
            covered,
            uncaptured,
            claimed,
            stale,
            suppressed,
            unattributed: unattributed.length,
        });

        if (notes.length === 0) {
            return { decision: "silent", reason, files: [], others };
        }

        return { decision: "noted", reason, message: notes.join("\n"), files: [], others };
    }

    if (drawnByMod) {
        const parts = [...blocks.flatMap((block) => (block.source ? [block.source] : [])), ...overflow];
        const unpatched = notShown.filter((path) => !overflow.some((part) => part.path === path));
        const path = writeFullDiff({
            toolUseId: payload.toolUseId,
            command: payload.command,
            parts,
            notShown: unpatched,
        });

        if (path) {
            // The mod draws only the patches that fit its budget, and nothing of a call past the file cap: keep
            // the link then, or such a diff has no visible trace at all.
            const undrawn =
                unpatched.length > 0 ||
                parts.reduce((total, part) => total + part.patch.length, 0) > MOD_MAX_PATCH_CHARS;
            // The mod draws a file from its first `@@` hunk (`sectionsOf`); a file with none (an empty file deleted
            // or created, a binary, a mode change) keeps its own header line here, or it vanished from the view.
            const hunkless = blocks
                .filter((block) => !/^@@ /m.test(block.source?.patch ?? ""))
                .map((block) => block.head);
            const message = [...hunkless, ...notes, ...(undrawn ? [`Full diff: ${path}`] : [])].join("\n");

            return {
                decision: message ? "noted" : "silent",
                reason: "the full-diff mod draws the diff",
                ...(message ? { message } : {}),
                files,
                attributed,
                others,
                stats: { chars: message.length, blocks: blocks.length, elided: 0, dropped: 0, fullDiff: path },
            };
        }
    }

    const noteChars = notes.reduce((total, line) => total + line.length + 2, 0);
    const budget = Math.max(0, (maxChars ?? diff.maxMessageChars) - noteChars);
    let fitted = fitMessage(blocks, { ...diff, maxMessageChars: budget });
    let body = fitted.message;
    let fullDiff: string | undefined;

    // Lines or files had to go: the whole diff goes to a file, and the message ends with a link to
    // it, fitted again with the link's room taken out of the budget.
    if ((fitted.elided > 0 || notShown.length > 0) && diff.fullDiff !== "off") {
        const path = writeFullDiff({
            toolUseId: payload.toolUseId,
            command: payload.command,
            parts: [...blocks.flatMap((block) => (block.source ? [block.source] : [])), ...overflow],
            notShown: notShown.filter((path) => !overflow.some((part) => part.path === path)),
            deferred,
            shownByHook: true,
        });
        const line = path ? fullDiffLine(path, diff.fullDiff) : null;

        if (path && line) {
            fullDiff = path;
            fitted = fitMessage(blocks, { ...diff, maxMessageChars: Math.max(0, budget - line.length - 1) });
            body = `${fitted.message}\n${line}`;
        }
    }

    const message = notes.length > 0 ? `${body}\n\n${notes.join("\n")}` : body;

    return {
        decision: "emitted",
        reason: "rendered a diff the harness did not",
        message,
        files,
        attributed,
        others,
        stats: {
            chars: message.length,
            blocks: blocks.length,
            elided: fitted.elided,
            dropped: notShown.length,
            ...(fullDiff ? { fullDiff } : {}),
        },
    };
}

/** What `attribute` needs for one post phase. Only what the command names is read eagerly. */
function attributionContext({
    payload,
    since,
    dir,
}: {
    payload: HookPayload;
    since: number;
    dir: string;
}): AttributionContext {
    const session = payload.sessionId ?? "";
    const actor = actorOf(payload);
    const now = Date.now();
    // The capture parser's paths too: it resolves `F=rel/a.ts; cd $R && edit $F` against the folder
    // `$F` is USED in, where the mention parser resolved it against the folder it was SET in, and the
    // file fell to "others" (11 calls on 2026-10-14).
    const named = mentionsFrom([
        ...mentionsOf({ tool: "Bash", input: { command: payload.command }, cwd: payload.cwd }),
        ...namedArguments(payload.command, commandDirs(payload.command, payload.cwd)).map(canonical),
    ]);
    let siblings: Set<string> | undefined;
    let mentions: Mentions | undefined;
    let readOnly: boolean | undefined;
    let others: Map<string, Touch[]> | undefined;
    let busy: Set<string> | undefined;

    return {
        session,
        since,
        now,
        named,
        mentions: () => {
            mentions ??= loadMentions(payload.sessionId);
            return mentions;
        },
        readOnly: () => {
            readOnly ??= readOnlyCommand(payload.command);
            return readOnly;
        },
        others: () => {
            others ??= othersTouches({ session: actor, since });
            return others;
        },
        siblings: () => {
            siblings ??= siblingNamed({ ownDir: dir, since, actor });
            return siblings;
        },
        busyRoots: () => {
            busy ??= inFlightRoots({ session, now });
            return busy;
        },
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

/**
 * An Edit, MultiEdit, Write or NotebookEdit call names its file outright, so it goes into this
 * session's mention index and the touches ledger at once. A later Bash post phase in another
 * session then knows the file is not its own, even when that session's command overlapped.
 * Never throws.
 */
export function noteFileToolInput(payload: HookPayload): void {
    try {
        const input = payload.raw.tool_input ?? payload.raw.toolInput;
        const named = mentionsOf({ tool: payload.tool, input, cwd: payload.cwd });

        if (named.length === 0 || !payload.sessionId) {
            return;
        }

        appendMentions({ sessionId: payload.sessionId, known: loadMentions(payload.sessionId), entries: named });

        const now = Date.now();

        recordTouches(
            named
                .filter((path) => !path.startsWith("glob:"))
                .map((path) => ({ session: actorOf(payload), start: now, end: now, kind: "named", path }))
        );
    } catch (err) {
        hookDiag("Could not note the file-tool input", { err });
    }
}
