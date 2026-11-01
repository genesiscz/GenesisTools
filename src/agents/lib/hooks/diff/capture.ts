import {
    type Dirent,
    lstatSync,
    mkdirSync,
    readdirSync,
    readlinkSync,
    type Stats,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type CopyFile, cloneOrCopy, type Placement } from "@genesiscz/utils/fs/clone";
import { isDatalessFile, underCloudRoot } from "@genesiscz/utils/fs/cloud-placeholder";
import type { StatusEntry } from "@genesiscz/utils/git/porcelain";
import { SafeJSON } from "@genesiscz/utils/json";
import { nativeHomePath } from "@genesiscz/utils/providers/session-paths";
import { type DiffConfig, defaultLogPath, megabytes } from "../config";
import { gitOut, isDeleted, isUntrackedDirectory, objectId, statusEntries, untrackedFilesIn } from "../git";
import { hookDiag } from "../log";
import { callDir, hookDataRoot, safeSegment } from "../paths";
import { HARNESS_HOOK_FACTS, type HookPayload } from "../payload";
import { actorOf, readOnlyCommand } from "./attribution";
import { commandDirs, namedArguments } from "./command-paths";
import { canonical, coverage, mentionsOf, refreshMentions } from "./mentions";
import { captureNamed } from "./named";
import { makePrivateDir } from "./private-dir";

/**
 * Files the hooks and the harness append to during EVERY call: the decision log and its rotated
 * generation, the hooks' own scratch, and Claude's transcripts. A command that only reads one
 * still "changes" it, because the hooks write it while the command runs. Observed 2026-10-14
 * 23:23: once the log rotated below the 2 MB named-path cap, a `tail` of it printed
 * `Updated ~/.genesis-tools/logs/agents-hooks.jsonl (+2 -0)`. Before, only the cap hid this.
 */
export function harnessOwnFile(path: string): boolean {
    const forms = new Set([path, canonical(path)]);
    const log = defaultLogPath();
    const scratch = dirname(hookDataRoot());
    const transcripts = nativeHomePath("claude", "projects");

    for (const form of forms) {
        if (form === log || form.startsWith(`${log}.`)) {
            return true;
        }

        for (const dir of new Set([scratch, canonical(scratch)])) {
            if (form.startsWith(`${dir}/`)) {
                return true;
            }
        }

        if (form.startsWith(`${transcripts}/`) && form.endsWith(".jsonl")) {
            return true;
        }
    }

    return false;
}

/** The Claude transcript this call belongs to, from the payload. */
export function transcriptOf(payload: HookPayload): string | null {
    return payload.transcriptPath || null;
}

export interface CaptureResult {
    roots: string[];
    captured: number;
    /** Files watched by path because the command named them. */
    named: number;
    skipped: string[];
}

/**
 * A capture holds copies of DIRTY files, which can include a `.env` a command just wrote, so
 * the tree is created mode 0700 and every file inside it 0600. `tmpdir()` is per-user and
 * mode 700 on macOS, but on Linux and in CI it is a world-readable `/tmp`, so the platform
 * cannot be relied on for this.
 */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function writePrivateFile(path: string, contents: string): void {
    writeFileSync(path, contents, { mode: FILE_MODE });
}

/** How one dirty entry went into the clone tree; `failed` was logged and has no before-state. */
type Stored = Placement | "failed";

/** What the caps allow for one entry: a clone under `clone.maxFileMB`, a copy under the copy caps. */
interface Allowed {
    mayClone: boolean;
    mayCopy: boolean;
}

interface CloneTree {
    /**
     * Puts `file` (repo-relative) into the tree, as a clone or a copy where the caps allow each. `declined` names
     * the paths below a directory entry that did not fit while the rest of it did.
     */
    put: (file: string, allowed: Allowed) => { stored: Stored; declined: string[] };
    /** Makes the symlinks `put` deferred and returns the paths whose link could not be made. */
    finish: () => string[];
}

/**
 * Root N's before-state: `<call>/<n>/` holds every captured dirty file at its repo-relative path, each an APFS
 * clone where the volume makes one (`cloneOrCopy`), which reads and writes no data. It replaced a `tar` of the
 * same files, about 770 KB written per call in this checkout (2026-11-01), and the post phase reads a clone by
 * path (`beforeCopy`).
 *
 * A symlink is stored as a link, as `tar` stored it: following one could copy a file from outside the
 * repository. Links are made after every file, so no file is ever written through a link the capture made, and
 * only regular files are read: a FIFO would block the hook forever.
 */
function cloneTree({ root, tree, copyFile }: { root: string; tree: string; copyFile?: CopyFile }): CloneTree {
    const links: Array<{ path: string; target: string; file: string }> = [];

    /**
     * Puts `file` (repo-relative) and adds to `declined` what did not fit below a directory that is otherwise stored.
     * A child the caps refuse used to give up the whole directory while its clones stayed, and the directory went
     * into `.left`, so a file the command then created in it read as one that existed. Now only that child does.
     */
    const place = (file: string, allowed: Allowed, declined: string[]): Placement => {
        const source = join(root, file);
        const destination = join(tree, file);
        const stat = lstatSync(source);

        if (stat.isSymbolicLink()) {
            links.push({ path: destination, target: readlinkSync(source), file });
            return "cloned";
        }

        if (stat.isDirectory()) {
            // An untracked nested repository is listed as one `nested/` entry; `tar` archived all of it.
            mkdirSync(destination, { recursive: true, mode: DIR_MODE });

            let placed: Placement = "cloned";
            let stored = 0;
            const refused: string[] = [];

            for (const item of readdirSync(source, { withFileTypes: true })) {
                const child = join(file, item.name);
                const below: string[] = [];
                const inner = place(child, allowed, below);

                if (inner === "declined") {
                    // A `dir/` entry covers every file under it (`leftOutOfCapture`).
                    refused.push(item.isDirectory() ? `${child}/` : child);
                    continue;
                }

                stored += 1;
                refused.push(...below);
                placed = inner === "copied" ? "copied" : placed;
            }

            // Nothing of it was stored, so the caller leaves the whole entry out.
            if (stored === 0 && refused.length > 0) {
                return "declined";
            }

            declined.push(...refused);
            return placed;
        }

        if (!stat.isFile()) {
            return "cloned";
        }

        mkdirSync(dirname(destination), { recursive: true, mode: DIR_MODE });
        return cloneOrCopy({ source, destination, mode: FILE_MODE, ...allowed, copyFile });
    };

    return {
        put: (file, allowed) => {
            const declined: string[] = [];

            try {
                return { stored: place(file, allowed, declined), declined };
            } catch (err) {
                hookDiag("Could not clone or copy a dirty file, so it has no before-state", { err, root, file });
                return { stored: "failed", declined: [] };
            }
        },
        finish: () => {
            const failed: string[] = [];

            for (const link of links) {
                try {
                    mkdirSync(dirname(link.path), { recursive: true, mode: DIR_MODE });
                    symlinkSync(link.target, link.path);
                } catch (err) {
                    hookDiag("Could not store a symlink, so it has no before-state", { err, path: link.path });
                    failed.push(link.file);
                }
            }

            return failed;
        },
    };
}

/**
 * The git repositories this command could have changed: one per directory it works in.
 *
 * `commandDirs` does the reading, through the scanner rather than a regex over the raw
 * command. A regex got all three of these wrong: it took only the FIRST `cd`, refused a
 * relative path, and truncated `cd /Users/x/My Repo` at the space.
 *
 * ⚠️ A directory the command merely NAMES is not a root, even when it is a repository. That
 * is deliberate (one `git rev-parse` per candidate costs about 8 ms on the hot path, and the
 * `git status` that follows in the post phase costs 30 to 60 ms more); files named that way
 * are watched individually instead, by `captureNamed`.
 */
export function captureRoots(payload: HookPayload, config: DiffConfig): string[] {
    return rootsOf(commandDirs(payload.command, payload.cwd), config).map((entry) => entry.root);
}

/**
 * The toplevel AND the HEAD it is on, in ONE `git rev-parse`.
 *
 * The HEAD is what lets the post phase notice a commit the command made: a file that was
 * edited and committed in the same call is clean again, so `git status` never mentions it.
 * Asking for it separately would be a second 8 ms spawn per directory on the hot path;
 * asking for both at once is free. An empty repository has no HEAD, and rev-parse then
 * echoes the literal `HEAD` and exits 128, which `objectId` rejects.
 */
function rootsOf(dirs: string[], config: DiffConfig, skipped: string[] = []): CapturedRoot[] {
    const roots: CapturedRoot[] = [];

    for (const dir of dirs) {
        if (roots.length >= config.maxRoots) {
            break;
        }

        // A repository inside a cloud storage folder is never a root: its `git status` and the copies of its dirty
        // files would read placeholders, and every read downloads one (see cloud-placeholder.ts).
        if (underCloudRoot(dir)) {
            skipped.push(`${dir}: under a cloud storage folder, not captured`);
            continue;
        }

        const lines = gitOut(dir, ["rev-parse", "--show-toplevel", "HEAD"], { quiet: true }).split("\n");
        const top = (lines[0] ?? "").trim();

        if (top.length > 0 && underCloudRoot(top)) {
            skipped.push(`${top}: under a cloud storage folder, not captured`);
            continue;
        }

        if (top.length > 0 && !roots.some((entry) => entry.root === top)) {
            roots.push({ root: top, head: objectId((lines[1] ?? "").trim()) });
        }
    }

    return roots;
}

interface CapturedRoot {
    root: string;
    head: string | null;
}

interface CapturePlan {
    take: string[];
    left: string[];
    reason: string | null;
}

/**
 * The files to size and capture for one root.
 *
 * 🛑 git collapses a wholly-untracked directory into one `scratch/` entry, and a capture handed
 * that entry takes EVERYTHING below it, gitignored credentials, databases and build output
 * included, into the hook's capture area. So such a directory is expanded through
 * `git ls-files --others --exclude-standard`, which lists only what git would report. One that
 * holds more files than the whole capture may take is left out as a unit rather than expanded
 * without bound, and deletions are skipped because there is nothing on disk to copy.
 */
function captureList({
    root,
    entries,
    config,
    mentioned,
}: {
    root: string;
    entries: StatusEntry[];
    config: DiffConfig;
    mentioned: (relativePath: string) => boolean;
}): { files: string[]; namesOnly: string[]; tooWide: string[] } {
    const files: string[] = [];
    const namesOnly: string[] = [];
    const tooWide: string[] = [];

    for (const entry of entries) {
        if (isDeleted(entry)) {
            continue;
        }

        // A dirty submodule is reported as its DIRECTORY. Handed to the capture it took the whole
        // checkout (its own ignored files included). Its before-state is the recorded commit,
        // which the post phase already diffs against HEAD as a `Subproject commit` change.
        if (entry.submodule?.startsWith("S")) {
            continue;
        }

        if (!isUntrackedDirectory(entry)) {
            files.push(entry.path);
            continue;
        }

        // The common directory fits the capture, and its listing stays as cheap as before. Only one
        // that overflows is listed again, by name, up to the larger cap.
        const small = untrackedFilesIn(root, entry.path, config.maxCaptureFiles + 1);
        const inside =
            small !== null && small.length > config.maxCaptureFiles
                ? untrackedFilesIn(root, entry.path, MAX_RECORDED_NAMES + 1)
                : small;

        // A listing that failed is left out as a unit too: treating it as empty would record
        // the directory as neither captured nor left out, and its files would read as created.
        if (inside === null || inside.length > MAX_RECORDED_NAMES) {
            tooWide.push(entry.path);
            continue;
        }

        if (inside.length <= config.maxCaptureFiles) {
            files.push(...inside);
            continue;
        }

        // Too many to size and copy, few enough to NAME. A name is what lets the post phase
        // tell a file that existed (no before-state, stays quiet) from one the command created
        // (diffed against empty). Only the session's own files among them compete for a copy.
        for (const name of inside) {
            (mentioned(name) ? files : namesOnly).push(name);
        }
    }

    return { files, namesOnly, tooWide };
}

/**
 * How many files of ONE wholly-untracked directory are listed by name when there are too many
 * to capture. Past it the directory is recorded as a unit, and a file created inside it reads
 * as one that existed. Measured 2026-09-30: the vault had 835 dirty entries against a 400-file
 * capture cap.
 */
const MAX_RECORDED_NAMES = 5_000;

/** Placeholder entries the skipped reason names before it only counts the rest. */
const NAMED_PLACEHOLDERS = 5;

/**
 * Which dirty files fit the budget, SMALLEST FIRST.
 *
 * 🛑 It used to be all-or-nothing: one breach of either cap abandoned the whole root. Measured
 * 2026-09-21 on the Obsidian vault, 64 dirty entries totalling 43 MB against an 8 MB cap, of
 * which three data files were 34 MB. So a 30 KB note being edited lost its before-state to
 * blobs it has nothing to do with, and the post phase then rendered it against `/dev/null` —
 * the whole file, labelled "Added", on every single call.
 *
 * Smallest first is what makes the common file survive a rare huge one. The paths that did
 * not fit are written out, because a file that EXISTED but has no copy must never be reported
 * as one the command created.
 *
 * Each file goes into the clone tree as it is taken. A clone is held to `clone.maxFileMB`, what
 * the post phase can still diff and log, and to the entry cap. The two copy caps bound the bytes
 * the pre phase WRITES, so only a real copy (a volume that cannot clone) spends them, and on such
 * a volume the result is the old plan.
 */
function fillCapture({
    root,
    files,
    config,
    mentioned,
    tree,
}: {
    root: string;
    files: string[];
    config: DiffConfig;
    mentioned: (relativePath: string) => boolean;
    tree: CloneTree;
}): CapturePlan {
    const cloneCap = megabytes(config.clone.maxFileMB);
    const copyCap = megabytes(config.maxCaptureFileMB);
    const totalCap = megabytes(config.maxCaptureMB);
    const sized = files.map((file) => {
        const found = { placeholder: false };
        const size = entryBytes(join(root, file), Math.max(cloneCap, copyCap), found);

        return { file, size, mine: mentioned(file), placeholder: found.placeholder };
    });

    // The session's own files first, then smallest first. Measured 2026-09-30 on the vault: 835
    // dirty entries, 400 captured, and the notes a session was editing were among the 435 left
    // out, so six of its edits that day printed nothing.
    sized.sort((left, right) => Number(right.mine) - Number(left.mine) || left.size - right.size);

    const take: string[] = [];
    const left: string[] = [];
    const placeholders: string[] = [];
    /** Paths below a taken directory that did not fit or could not be stored, left out on their own. */
    const inside: string[] = [];
    let copied = 0;
    let failed = 0;

    for (const entry of sized) {
        // A clone of a dataless file makes no sense and a copy reads it, which downloads it.
        if (entry.placeholder) {
            left.push(entry.file);
            placeholders.push(entry.file);
            continue;
        }

        const allowed = {
            mayClone: entry.size <= cloneCap,
            mayCopy: entry.size <= copyCap && copied + entry.size <= totalCap,
        };

        if ((!allowed.mayClone && entry.size > copyCap) || take.length >= config.maxCaptureFiles) {
            left.push(entry.file);
            continue;
        }

        const { stored, declined } = tree.put(entry.file, allowed);

        if (stored === "failed") {
            failed += 1;
        }

        if (stored === "failed" || stored === "declined") {
            left.push(entry.file);
            continue;
        }

        copied += stored === "copied" ? entry.size : 0;
        take.push(entry.file);
        inside.push(...declined);
    }

    for (const file of tree.finish()) {
        const at = take.indexOf(file);

        // A link below a taken directory leaves only itself out; the directory's other files keep their copies.
        if (at < 0) {
            inside.push(file);
            continue;
        }

        take.splice(at, 1);
        left.push(file);
        failed += 1;
    }

    const why: string[] = [];

    if (left.length > placeholders.length + failed) {
        why.push(
            `over the ${config.clone.maxFileMB} MB per-entry clone / ${config.maxCaptureFileMB} MB per-entry copy / ${config.maxCaptureMB} MB total copied / ${config.maxCaptureFiles} entry cap`
        );
    }

    // Named, so the log says which file was refused; the full list is in the `.left` file.
    if (placeholders.length > 0) {
        const shown = placeholders.slice(0, NAMED_PLACEHOLDERS).join(", ");
        const more =
            placeholders.length > NAMED_PLACEHOLDERS ? ` and ${placeholders.length - NAMED_PLACEHOLDERS} more` : "";

        why.push(`${placeholders.length} hold cloud placeholders a read would download (${shown}${more})`);
    }

    if (failed > 0) {
        why.push(`${failed} could not be cloned or copied`);
    }

    const reasons = [
        ...(left.length > 0 ? [`${left.length} of ${files.length} dirty entries left out, ${why.join("; ")}`] : []),
        ...(inside.length > 0
            ? [`${inside.length} path(s) inside a captured directory left out, over the caps or not storable`]
            : []),
    ];

    return { take, left: [...left, ...inside], reason: reasons.length > 0 ? reasons.join("; ") : null };
}

/**
 * The bytes one status entry really costs.
 *
 * 🛑 A wholly-untracked DIRECTORY is ONE status entry and a whole tree on disk, and
 * `statSync` reports the directory inode, not its contents. Measured 2026-09-21 on the
 * Obsidian vault: an 11.2 MB untracked directory weighed in at 704 bytes and sailed straight
 * through a cap of eight million, which is how a budgeted capture still wrote tens of
 * megabytes per command.
 *
 * The walk stops as soon as it is over `limit`, so a huge tree costs a few `readdir` calls
 * rather than a full traversal, and a symlink is never followed: the capture stores the link, and
 * following one could count a target outside the repository or loop.
 */
function entryBytes(path: string, limit: number, found: { placeholder: boolean }): number {
    let stat: Stats;

    try {
        stat = lstatSync(path);
    } catch {
        // A path that vanished between `status` and here. It contributes no size and is not
        // worth a log line: this fires on every staged deletion.
        return 0;
    }

    if (stat.isSymbolicLink()) {
        return 0;
    }

    if (!stat.isDirectory()) {
        found.placeholder = isDatalessFile(stat);
        return stat.size;
    }

    let total = 0;
    const pending = [path];

    while (pending.length > 0) {
        const dir = pending.pop();

        if (dir === undefined) {
            break;
        }

        let listing: Dirent[];

        try {
            listing = readdirSync(dir, { withFileTypes: true });
        } catch (err) {
            hookDiag("Could not size an untracked directory", { err, dir });
            continue;
        }

        for (const item of listing) {
            if (item.isSymbolicLink()) {
                continue;
            }

            const child = join(dir, item.name);

            if (item.isDirectory()) {
                pending.push(child);
                continue;
            }

            try {
                const childStat = lstatSync(child);

                if (isDatalessFile(childStat)) {
                    found.placeholder = true;
                    return total;
                }

                total += childStat.size;
            } catch {
                // Same vanishing-path case as above, one level down.
            }

            if (total > limit) {
                return total;
            }
        }
    }

    return total;
}

/**
 * Only DIRTY files are captured: git already holds the before-state of every clean file,
 * so "what did this command change" needs nothing more. Measured on GenesisTools: 14 dirty
 * files, 54 ms, one `git status` and one `tar` (a clone tree since 2026-11-01).
 *
 * `copyFile` is the clone primitive, a parameter so a test can see its flags or make it fail.
 */
export function capturePre(
    payload: HookPayload,
    config: DiffConfig,
    { copyFile }: { copyFile?: CopyFile } = {}
): CaptureResult {
    const dirs = commandDirs(payload.command, payload.cwd);
    const skipped: string[] = [];
    const captured_roots = rootsOf(dirs, config, skipped);
    const roots = captured_roots.map((entry) => entry.root);
    const wanted = config.watchNamedPaths
        ? namedArguments(payload.command, dirs).filter((path) => !harnessOwnFile(path))
        : [];
    let captured = 0;

    const session = safeSegment(payload.sessionId);
    const call = safeSegment(payload.toolUseId);

    if (session === null || call === null) {
        if (payload.sessionId && payload.toolUseId) {
            // Not a normal absence: the payload named an id that cannot be a path segment.
            hookDiag("Refusing to capture under an unsafe identifier", {
                sessionId: payload.sessionId,
                toolUseId: payload.toolUseId,
            });
        }

        return { roots, captured, named: 0, skipped };
    }

    // Before the early return below: a command outside every repository still names paths
    // that a later command's post phase must recognise as this session's.
    const mentions = refreshMentions({
        sessionId: payload.sessionId,
        transcript: HARNESS_HOOK_FACTS[payload.harness].transcriptMentions ? transcriptOf(payload) : null,
        current: { tool: "Bash", input: { command: payload.command }, cwd: payload.cwd },
        roots,
    });

    if (roots.length === 0 && wanted.length === 0) {
        // Nothing to compare later, so no directory is created and the collector has nothing
        // to sweep. This is the normal case for a command that touches no file at all.
        return { roots, captured, named: 0, skipped };
    }

    const dir = callDir(payload.harness, session, call);

    const refused = makePrivateDir(dir);

    if (refused) {
        hookDiag("Refusing to capture into a directory this user does not control", { dir, refused });
        skipped.push(`capture refused: ${refused}`);
        return { roots, captured, named: 0, skipped };
    }

    // A command that only reads gets no before-state. Its post phase gives every change in the call
    // to another writer (`attribute`) and never opens a copy, so a copy bought nothing: 12,409 calls
    // on 2026-11-01 each put the dirty files into a tar, `ls` and `tail` included. Every file the
    // post phase reads stays, so its answer (silent, the other writers' files, a stale deletion) is
    // the same.
    const readOnly = readOnlyCommand(payload.command);

    // The named-path pass runs FIRST so a capture with no git root still produces a call
    // directory. The post phase gates on `roots.txt`, and returning early when `roots` was
    // empty is exactly what made an edit outside every repository unreportable.
    const named = captureNamed({ dir, paths: wanted, config, takeCopies: !readOnly, copyFile });

    skipped.push(...named.skipped);
    writePrivateFile(join(dir, "stamp"), String(Math.floor(Date.now() / 1000)));
    // `stamp` is whole seconds (mtime comparisons); the writer journal needs the real start.
    writePrivateFile(join(dir, "started-ms"), String(Date.now()));
    writePrivateFile(join(dir, "roots.txt"), roots.length > 0 ? `${roots.join("\n")}\n` : "");
    // What this call names, canonical, so a PARALLEL call of the same session (or a subagent's)
    // whose post phase runs while this one is still in flight can leave these files to it.
    const ownNamed = [
        ...wanted,
        ...mentionsOf({ tool: "Bash", input: { command: payload.command }, cwd: payload.cwd }).filter(
            (path) => !path.startsWith("glob:")
        ),
    ].map(canonical);
    writePrivateFile(join(dir, "named.txt"), `${[...new Set(ownNamed)].join("\n")}\n`);
    // The call itself, for a background call whose diff is taken when the task ends, not now.
    writePrivateFile(
        join(dir, "call.json"),
        SafeJSON.stringify({
            command: payload.command,
            cwd: payload.cwd,
            event: payload.event,
            actor: actorOf(payload),
        })
    );
    // One line per root, aligned by index with roots.txt. An empty line means "no HEAD".
    writePrivateFile(join(dir, "heads.txt"), captured_roots.map((entry) => entry.head ?? "").join("\n"));

    roots.forEach((root, index) => {
        const entries = statusEntries(root);
        // A DELETED path is excluded: it is gone from disk, so there is nothing to copy (one
        // such entry used to make `tar` exit 1 and discard the whole archive, 2026-09-20). The
        // post phase renders a deletion from `git diff HEAD` and needs no captured copy.
        // Excluding them also leaves the post phase unable to tell a deletion this command
        // MADE from one that was already sitting in `git status`. Writing the names down is
        // what closes that, for a reading command too. See `alreadyGone` for the measurement.
        const gone = entries.filter(isDeleted).map((entry) => entry.path);

        if (gone.length > 0) {
            writePrivateFile(join(dir, `${index + 1}.gone`), `${gone.join("\n")}\n`);
        }

        if (readOnly) {
            return;
        }

        const named = coverage({ mentions: mentions.current, root, reach: "deep" });
        const earlier = coverage({ mentions: mentions.index, root, reach: "shallow" });
        const mentioned = (name: string) => named(join(root, name)) || earlier(join(root, name));
        const { files, namesOnly, tooWide } = captureList({ root, entries, config, mentioned });

        if (files.length === 0 && namesOnly.length === 0 && tooWide.length === 0) {
            return;
        }

        const tree = cloneTree({ root, tree: join(dir, String(index + 1)), copyFile });
        const plan = fillCapture({ root, files, config, mentioned, tree });
        const left = [...plan.left, ...namesOnly, ...tooWide];

        // The refusal is RECORDED rather than silent, so the post phase can tell a file it
        // has no copy of from a file the command genuinely created. A directory too wide to
        // expand is recorded whole; `leftOutOfCapture` matches every file under a `dir/` entry.
        if (left.length > 0) {
            skipped.push(
                `${root}: ${plan.reason ?? `${namesOnly.length} untracked file(s) named but not captured, ${tooWide.length} untracked director(ies) over the ${MAX_RECORDED_NAMES} name cap left out`}`
            );
            writePrivateFile(join(dir, `${index + 1}.left`), `${left.join("\n")}\n`);
        }

        captured += plan.take.length;
    });

    return { roots, captured, named: named.entries.length, skipped };
}
