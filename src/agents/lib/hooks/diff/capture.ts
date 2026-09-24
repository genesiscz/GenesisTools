import { spawnSync } from "node:child_process";
import { chmodSync, type Dirent, lstatSync, mkdirSync, readdirSync, type Stats, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { StatusEntry } from "@genesiscz/utils/git/porcelain";
import { type DiffConfig, megabytes } from "../config";
import { gitOut, isDeleted, isUntrackedDirectory, objectId, statusEntries, untrackedFilesIn } from "../git";
import { hookDiag } from "../log";
import { callDir, safeSegment } from "../paths";
import type { HookPayload } from "../payload";
import { commandDirs, namedArguments } from "./command-paths";
import { captureNamed } from "./named";

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
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Creates `dir` and proves that every directory from `tmpdir()` down to it is a plain directory
 * owned by this user. Setting 0700 on the leaf alone was not enough on a shared `/tmp`: another
 * user could pre-create `GenesisTools/...` or plant a symlink in the chain, and the copies of
 * dirty files would land in a tree that user controls. Returns the reason it refused, or `null`.
 */
function makePrivateDir(dir: string): string | null {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });

    const base = tmpdir();
    const rel = relative(base, dir);
    const parts = rel.startsWith("..") || isAbsolute(rel) ? [] : rel.split(sep);
    const chain = parts.length === 0 ? [dir] : parts.map((_, i) => join(base, ...parts.slice(0, i + 1)));
    const uid = process.getuid?.();

    for (const path of chain) {
        const stat = lstatSync(path);

        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            return `${path} is not a plain directory`;
        }

        if (uid !== undefined && stat.uid !== uid) {
            return `${path} belongs to uid ${stat.uid}, not to this user`;
        }

        try {
            // `mkdirSync`'s mode is masked by the umask, and the parents may pre-date this call.
            chmodSync(path, DIR_MODE);
        } catch (err) {
            hookDiag("Could not tighten a capture directory mode", { err, path });
        }
    }

    return null;
}

function writePrivateFile(path: string, contents: string): void {
    writeFileSync(path, contents, { mode: FILE_MODE });
}

function tighten(path: string): void {
    try {
        chmodSync(path, FILE_MODE);
    } catch (err) {
        hookDiag("Could not tighten a capture file mode", { err, path });
    }
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
function rootsOf(dirs: string[], config: DiffConfig): CapturedRoot[] {
    const roots: CapturedRoot[] = [];

    for (const dir of dirs) {
        if (roots.length >= config.maxRoots) {
            break;
        }

        const lines = gitOut(dir, ["rev-parse", "--show-toplevel", "HEAD"], { quiet: true }).split("\n");
        const top = (lines[0] ?? "").trim();

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
 * The files to size and archive for one root.
 *
 * 🛑 git collapses a wholly-untracked directory into one `scratch/` entry, and `tar` handed that
 * entry archives EVERYTHING below it, gitignored credentials, databases and build output
 * included, into the hook's capture area. So such a directory is expanded through
 * `git ls-files --others --exclude-standard`, which lists only what git would report. One that
 * holds more files than the whole capture may take is left out as a unit rather than expanded
 * without bound, and deletions are skipped because `tar` cannot stat them.
 */
function captureList(root: string, entries: StatusEntry[], config: DiffConfig): { files: string[]; tooWide: string[] } {
    const files: string[] = [];
    const tooWide: string[] = [];

    for (const entry of entries) {
        if (isDeleted(entry)) {
            continue;
        }

        // A dirty submodule is reported as its DIRECTORY. Handed to `tar` it archived the whole
        // checkout (its own ignored files included). Its before-state is the recorded commit,
        // which the post phase already diffs against HEAD as a `Subproject commit` change.
        if (entry.submodule?.startsWith("S")) {
            continue;
        }

        if (!isUntrackedDirectory(entry)) {
            files.push(entry.path);
            continue;
        }

        const inside = untrackedFilesIn(root, entry.path, config.maxCaptureFiles + 1);

        // A listing that failed is left out as a unit too: treating it as empty would record
        // the directory as neither captured nor left out, and its files would read as created.
        if (inside === null || inside.length > config.maxCaptureFiles) {
            tooWide.push(entry.path);
            continue;
        }

        files.push(...inside);
    }

    return { files, tooWide };
}

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
 */
function planCapture(root: string, files: string[], config: DiffConfig): CapturePlan {
    const fileCap = megabytes(config.maxCaptureFileMB);
    const totalCap = megabytes(config.maxCaptureMB);
    const sized = files.map((file) => ({
        file,
        size: entryBytes(join(root, file), fileCap),
    }));

    sized.sort((left, right) => left.size - right.size);

    const take: string[] = [];
    const left: string[] = [];
    let bytes = 0;

    for (const entry of sized) {
        const overFile = entry.size > fileCap;
        const overTotal = bytes + entry.size > totalCap;

        if (overFile || overTotal || take.length >= config.maxCaptureFiles) {
            left.push(entry.file);
            continue;
        }

        bytes += entry.size;
        take.push(entry.file);
    }

    const reason =
        left.length > 0
            ? `${left.length} of ${files.length} dirty entries left out, over the ${config.maxCaptureFileMB} MB per-entry / ${config.maxCaptureMB} MB total / ${config.maxCaptureFiles} entry cap`
            : null;

    return { take, left, reason };
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
 * rather than a full traversal, and a symlink is never followed: `tar` stores the link, and
 * following one could count a target outside the repository or loop.
 */
function entryBytes(path: string, limit: number): number {
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
                total += lstatSync(child).size;
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
 * files, 54 ms, one `git status` and one `tar`.
 */
export function capturePre(payload: HookPayload, config: DiffConfig): CaptureResult {
    const dirs = commandDirs(payload.command, payload.cwd);
    const captured_roots = rootsOf(dirs, config);
    const roots = captured_roots.map((entry) => entry.root);
    const wanted = config.watchNamedPaths ? namedArguments(payload.command, dirs) : [];
    const skipped: string[] = [];
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

    // The named-path pass runs FIRST so a capture with no git root still produces a call
    // directory. The post phase gates on `roots.txt`, and returning early when `roots` was
    // empty is exactly what made an edit outside every repository unreportable.
    const named = captureNamed(dir, wanted, config);

    skipped.push(...named.skipped);
    writePrivateFile(join(dir, "stamp"), String(Math.floor(Date.now() / 1000)));
    writePrivateFile(join(dir, "roots.txt"), roots.length > 0 ? `${roots.join("\n")}\n` : "");
    // One line per root, aligned by index with roots.txt. An empty line means "no HEAD".
    writePrivateFile(join(dir, "heads.txt"), captured_roots.map((entry) => entry.head ?? "").join("\n"));

    roots.forEach((root, index) => {
        const entries = statusEntries(root);
        // A DELETED path is excluded: it is gone from disk, so `tar` cannot stat it and
        // exits 1, and one such entry discards the whole archive — the root then loses its
        // before-state for every file. Observed on 2026-09-20 during a `git rm`. The post
        // phase renders a deletion from `git diff HEAD` and needs no captured copy.
        const { files, tooWide } = captureList(root, entries, config);
        // Excluding them from the archive also leaves the post phase unable to tell a
        // deletion this command MADE from one that was already sitting in `git status`.
        // Writing the names down is what closes that. See `alreadyGone` for the measurement.
        const gone = entries.filter(isDeleted).map((entry) => entry.path);

        if (gone.length > 0) {
            writePrivateFile(join(dir, `${index + 1}.gone`), `${gone.join("\n")}\n`);
        }

        if (files.length === 0 && tooWide.length === 0) {
            return;
        }

        const plan = planCapture(root, files, config);
        const left = [...plan.left, ...tooWide];

        // The refusal is RECORDED rather than silent, so the post phase can tell a file it
        // has no copy of from a file the command genuinely created. A directory too wide to
        // expand is recorded whole; `leftOutOfCapture` matches every file under a `dir/` entry.
        if (left.length > 0) {
            skipped.push(
                `${root}: ${plan.reason ?? `${tooWide.length} untracked director(ies) over the ${config.maxCaptureFiles} file cap left out`}`
            );
            writePrivateFile(join(dir, `${index + 1}.left`), `${left.join("\n")}\n`);
        }

        if (plan.take.length === 0) {
            return;
        }

        const tar = join(dir, `${index + 1}.tar`);
        // `--` before the file list: a repository file literally named `-C` or `--exclude=…`
        // would otherwise be read by tar as an option, and `-C /` re-roots the archive. Any
        // writer of the repository can create such a name.
        const run = spawnSync("tar", ["-C", root, "-cf", tar, "--", ...plan.take], { encoding: "utf8" });

        if (run.status === 0) {
            tighten(tar);
            captured += plan.take.length;
            return;
        }

        hookDiag("tar failed, so this root has no before-state", {
            root,
            status: run.status,
            stderr: typeof run.stderr === "string" ? run.stderr.slice(0, 400) : undefined,
        });
    });

    return { roots, captured, named: named.entries.length, skipped };
}
