import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { StatusEntry } from "@genesiscz/utils/git/porcelain";
import {
    commandTokenIndex,
    commandWord,
    nextRawArgument,
    type ShellScan,
    scanShell,
    splitPipeline,
    tokenize,
} from "@genesiscz/utils/shell/scan";
import type { DiffConfig } from "../config";
import { gitOut, isDeleted, isUntrackedDirectory, statusEntries, untrackedFilesIn } from "../git";
import { hookDiag } from "../log";
import { callDir, safeSegment } from "../paths";
import type { HookPayload } from "../payload";

export interface CaptureResult {
    roots: string[];
    captured: number;
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
 * Every directory this command could have edited: the session cwd, plus the target of EVERY
 * `cd` it names, relative ones included.
 *
 * The scanner does the work rather than a regex over the raw command. `scanShell` blanks
 * quoted spans to equal-length runs, so `echo "cd /etc"` cannot add a root, and because the
 * cleaned text is the same length as the original, `nextRawArgument` can read the real target
 * back out of `command` — quotes, spaces and all. A regex over the raw text got all three
 * wrong: it took only the FIRST `cd`, refused a relative path, and truncated
 * `cd /Users/x/My Repo` at the space.
 */
export function captureRoots(payload: HookPayload, config: DiffConfig): string[] {
    const dirs = [payload.cwd];

    for (const target of cdTargets(payload.command)) {
        const dir = isAbsolute(target) ? target : resolve(payload.cwd, target);

        // A directory that does not exist cannot be what the command changed, and asking git
        // about it would only cost a spawn. This is also the backstop for a target the raw
        // read got wrong in a way `plainArgument` did not catch.
        if (existsSync(dir)) {
            dirs.push(dir);
        }
    }

    const roots: string[] = [];

    for (const dir of dirs) {
        if (roots.length >= config.maxRoots) {
            break;
        }

        const top = gitOut(dir, ["rev-parse", "--show-toplevel"], { quiet: true }).trim();

        if (top.length > 0 && !roots.includes(top)) {
            roots.push(top);
        }
    }

    return roots;
}

/**
 * The argument as a PLAIN path, or `null` when the shell would not read it that way.
 *
 * `nextRawArgument` is a naive quote matcher over raw text: it knows nothing about backslash
 * escapes, command substitution, or adjacent quoted runs such as `'a'b'c'`. Guessing there
 * would hand a path the shell never meant to `git -C`. So anything with an escape, an inner
 * quote, a substitution or a variable is REFUSED, and the caller simply does not capture that
 * root. A missing root costs one diff; a wrong root is a wrong answer.
 */
function plainArgument(raw: string | null): string | null {
    if (!raw) {
        return null;
    }

    const quoted = /^(['"])(.*)\1$/.exec(raw);
    const value = quoted?.[2] ?? raw;

    if (value.length === 0 || value === "-" || /["'\\$`]/.test(value)) {
        return null;
    }

    return value;
}

/** Each `cd` argument the command names, in order, read from the ORIGINAL text. */
function cdTargets(command: string): string[] {
    const targets: string[] = [];
    let scan: ShellScan;

    try {
        scan = scanShell(command);
    } catch (err) {
        // A scanner that throws must not cost the capture its cwd root.
        hookDiag("Could not scan the command for a cd target", { err });
        return targets;
    }

    for (const unit of scan.units) {
        for (const statement of unit) {
            for (const element of splitPipeline(statement)) {
                const tokens = tokenize(element);
                const index = commandTokenIndex(tokens);
                const token = index === -1 ? undefined : tokens[index];

                if (!token || commandWord(token.text) !== "cd") {
                    continue;
                }

                const target = plainArgument(nextRawArgument(command, token.start + token.text.length));

                if (target) {
                    targets.push(target);
                }
            }
        }
    }

    return targets;
}

/**
 * The dirty paths to archive, with every wholly-untracked directory expanded into its files.
 * The directory entry itself reached `tar` whole, ignored files included, and `stat` sized its
 * inode rather than its contents, so a build output or dataset slipped past both caps. The list
 * stops one past the file cap, which is all `tooLarge` needs to refuse it.
 */
function captureList(root: string, entries: StatusEntry[], config: DiffConfig): string[] {
    const limit = config.maxCaptureFiles + 1;
    const files: string[] = [];

    for (const entry of entries) {
        if (files.length >= limit) {
            break;
        }

        if (isDeleted(entry)) {
            continue;
        }

        // A dirty submodule is reported as its DIRECTORY. Handed to `tar` it archived the whole
        // checkout (its own ignored files included) and `stat` sized only the directory inode,
        // so it slipped past both caps. Its before-state is the recorded commit, which the post
        // phase already diffs against HEAD as a `Subproject commit` change.
        if (entry.submodule?.startsWith("S")) {
            continue;
        }

        if (isUntrackedDirectory(entry)) {
            files.push(...untrackedFilesIn(root, entry.path, limit - files.length));
            continue;
        }

        files.push(entry.path);
    }

    return files;
}

/** Names the cap a capture would breach, or `null` when it fits. */
function tooLarge(root: string, files: string[], config: DiffConfig): string | null {
    if (files.length > config.maxCaptureFiles) {
        return `skipped: more than ${config.maxCaptureFiles} dirty files, over the cap`;
    }

    let bytes = 0;

    for (const file of files) {
        try {
            bytes += statSync(join(root, file)).size;
        } catch {
            // A deleted path, or one that vanished between `status` and `stat`. Neither
            // contributes a size, neither is a reason to abandon the capture, and neither is
            // worth a log line: this fires on every staged deletion.
        }

        if (bytes > config.maxCaptureBytes) {
            return `skipped: over the ${config.maxCaptureBytes} byte cap`;
        }
    }

    return null;
}

/**
 * Only DIRTY files are captured: git already holds the before-state of every clean file,
 * so "what did this command change" needs nothing more. Measured on GenesisTools: 14 dirty
 * files, 54 ms, one `git status` and one `tar`.
 */
export function capturePre(payload: HookPayload, config: DiffConfig): CaptureResult {
    const roots = captureRoots(payload, config);
    const skipped: string[] = [];
    let captured = 0;

    const session = safeSegment(payload.sessionId);
    const call = safeSegment(payload.toolUseId);

    if (session === null || call === null || roots.length === 0) {
        if (payload.sessionId && payload.toolUseId && (session === null || call === null)) {
            // Not a normal absence: the payload named an id that cannot be a path segment.
            hookDiag("Refusing to capture under an unsafe identifier", {
                sessionId: payload.sessionId,
                toolUseId: payload.toolUseId,
            });
        }

        return { roots, captured, skipped };
    }

    const dir = callDir(payload.harness, session, call);

    const refused = makePrivateDir(dir);

    if (refused) {
        hookDiag("Refusing to capture into a directory this user does not control", { dir, refused });
        skipped.push(`capture refused: ${refused}`);
        return { roots, captured, skipped };
    }

    writePrivateFile(join(dir, "stamp"), String(Math.floor(Date.now() / 1000)));
    writePrivateFile(join(dir, "roots.txt"), `${roots.join("\n")}\n`);

    roots.forEach((root, index) => {
        // A DELETED path is excluded: it is gone from disk, so `tar` cannot stat it and
        // exits 1, and one such entry discards the whole archive — the root then loses its
        // before-state for every file. Observed on 2026-09-20 during a `git rm`. The post
        // phase renders a deletion from `git diff HEAD` and needs no captured copy.
        const entries = statusEntries(root);
        // A deletion already in the worktree is recorded, so the post phase does not report it
        // again after every later command until it is committed.
        const deleted = entries.filter(isDeleted).map((entry) => resolve(root, entry.path));

        if (deleted.length > 0) {
            writePrivateFile(join(dir, `${index + 1}.deleted`), deleted.join("\0"));
        }

        const files = captureList(root, entries, config);

        if (files.length === 0) {
            return;
        }

        // A tree this dirty is not a normal edit; capturing it is not worth the disk. The
        // refusal is RECORDED rather than silent, so the post phase's fallback to `HEAD`
        // shows up in the log instead of looking like a wrong diff.
        const reason = tooLarge(root, files, config);

        if (reason) {
            skipped.push(`${root}: ${reason}`);
            writePrivateFile(join(dir, `${index + 1}.skipped`), reason);
            return;
        }

        const tar = join(dir, `${index + 1}.tar`);
        // `--` before the file list: a repository file literally named `-C` or `--exclude=…`
        // would otherwise be read by tar as an option, and `-C /` re-roots the archive. Any
        // writer of the repository can create such a name.
        const run = spawnSync("tar", ["-C", root, "-cf", tar, "--", ...files], { encoding: "utf8" });

        if (run.status === 0) {
            tighten(tar);
            captured += files.length;
            return;
        }

        hookDiag("tar failed, so this root has no before-state", {
            root,
            status: run.status,
            stderr: typeof run.stderr === "string" ? run.stderr.slice(0, 400) : undefined,
        });
    });

    return { roots, captured, skipped };
}
