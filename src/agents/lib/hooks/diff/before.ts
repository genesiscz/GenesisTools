import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { hookDiag } from "../log";

/** The extracted copy can hold secrets, exactly like the tar it came from. */
const FILE_MODE = 0o600;

/**
 * Where the pre phase put this root's before-state: the clone tree `<n>/` (`cloneTree` in capture.ts), or
 * `<n>.tar` from a hook older than 2026-11-01. A background call captured before an upgrade is diffed after it,
 * when its task ends, so the archive is still read; no other code writes one.
 */
type Capture = { tree: string } | { tar: string } | null;

function captureOf(dir: string, root: string): Capture {
    const index = rootIndex(dir, root);

    if (index < 0) {
        return null;
    }

    const tree = join(dir, String(index + 1));

    if (existsSync(tree)) {
        return { tree };
    }

    const tar = join(dir, `${index + 1}.tar`);

    return existsSync(tar) ? { tar } : null;
}

/**
 * The clone of `member` (a file, or a link stored as a link), or `null` when the file was clean when the command
 * began. Read where the capture put it: the clone is the before-state, so nothing is extracted or written.
 *
 * Its folder must be a real folder of the tree: a stored link that `member` reaches THROUGH (`link/passwd`) would
 * hand the post phase a file outside the repository, which the archive, holding the link as an entry, never did.
 */
function inTree(tree: string, member: string): string | null {
    const path = join(tree, member);

    try {
        lstatSync(path);
    } catch {
        // Absent is the normal case: the file was clean when the command began.
        return null;
    }

    try {
        const folder = realpathSync(dirname(path));
        const top = realpathSync(tree);

        return folder === top || folder.startsWith(`${top}/`) || folder.startsWith(`${top}\\`) ? path : null;
    } catch (err) {
        hookDiag("Could not resolve a clone in the capture tree, so it has no before-state", { err, path });
        return null;
    }
}

/**
 * The captured copy as a path `git diff --no-index` can read: the clone itself, or one written out of an archive.
 *
 * `null` is a meaningful answer, not a failure: it means the file was CLEAN when the command
 * began, so it is absent from the capture and git itself holds the before-state. The caller falls
 * back to `git diff HEAD` rather than passing a path that does not exist, which would make
 * `--no-index` exit 128 with an empty patch that reads exactly like "nothing changed".
 */
function rootIndex(dir: string, root: string): number {
    const rootsFile = join(dir, "roots.txt");

    if (!existsSync(rootsFile)) {
        return -1;
    }

    return readFileSync(rootsFile, "utf8").split("\n").filter(Boolean).indexOf(root);
}

/**
 * Whether this file was DIRTY when the command began but did not fit the capture budget.
 *
 * It is the difference between "the command created this file" and "the command changed a
 * file we have no copy of". Without it, the second reads as the first: the post phase diffs
 * an untracked file against `/dev/null` and prints the whole thing as `Added`, once per call,
 * forever. Observed 2026-09-21 on a wrap-up note in the Obsidian vault: four calls, four
 * whole-file renders, +157 then +284 then +448 then +647.
 */
/**
 * Whether this path was ALREADY deleted when the command began.
 *
 * A deletion has no mtime, so it cannot pass the `since` filter an edit passes: `changedFiles`
 * admits every deletion git reports, unconditionally. That is right for the command that made
 * the deletion and wrong for every command after it, because `git status` keeps reporting a
 * deletion until it is staged away or committed.
 *
 * Measured 2026-09-21 on a `git rm --cached` of one file: the removal rendered 14 times over
 * seven minutes, once per later command that worked in that repository, and stopped only when
 * the deletion was committed. 13 of the 14 were spurious.
 */
export function alreadyGone({ dir, root, absolute }: { dir: string; root: string; absolute: string }): boolean {
    const index = rootIndex(dir, root);

    if (index < 0) {
        return false;
    }

    const listPath = join(dir, `${index + 1}.gone`);

    if (!existsSync(listPath)) {
        return false;
    }

    // git never collapses deletions the way it collapses an untracked directory, so every
    // entry here is a whole path and an exact match is the right test.
    const member = relative(root, absolute).normalize("NFC");

    return readFileSync(listPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .some((entry) => entry.normalize("NFC") === member);
}

export function leftOutOfCapture({ dir, root, absolute }: { dir: string; root: string; absolute: string }): boolean {
    const index = rootIndex(dir, root);

    if (index < 0) {
        return false;
    }

    const listPath = join(dir, `${index + 1}.left`);

    if (!existsSync(listPath)) {
        return false;
    }

    // Both sides come from git, so both are NFC today. Normalising anyway costs nothing and
    // keeps this honest if either side ever arrives in the other form, the way the tar member
    // names already do.
    const member = relative(root, absolute).normalize("NFC");

    // git collapses a wholly-untracked directory into one `scratch/` entry, and that is the
    // form the capture plan stores. The post phase expands it back into `scratch/note.md`,
    // so an exact match alone would miss every file inside exactly such a directory — which
    // is the shape the vault case actually had.
    return readFileSync(listPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((entry) => entry.normalize("NFC"))
        .some((entry) => entry === member || (entry.endsWith("/") && member.startsWith(entry)));
}

export function beforeCopy({ dir, root, absolute }: { dir: string; root: string; absolute: string }): string | null {
    const capture = captureOf(dir, root);

    if (capture === null) {
        return null;
    }

    if ("tree" in capture) {
        return inTree(capture.tree, relative(root, absolute));
    }

    return fromArchive({ dir, tar: capture.tar, root, absolute });
}

/** The before-copy out of an archive an older hook wrote, written next to it for `git diff --no-index`. */
function fromArchive({
    dir,
    tar,
    root,
    absolute,
}: {
    dir: string;
    tar: string;
    root: string;
    absolute: string;
}): string | null {
    // A directory captured as `scratch/` stores its members as `scratch/a.ts`, so the
    // repo-relative path is the member name for both a plain file and one inside a wholly
    // untracked directory. Verified against bsdtar on 2026-09-20.
    const stdout = extract(tar, relative(root, absolute));

    if (stdout === null) {
        return null;
    }

    const out = join(dir, `before-${Bun.hash(absolute).toString(36)}`);

    try {
        writeFileSync(out, stdout, { mode: FILE_MODE });
        return out;
    } catch (err) {
        hookDiag("Could not write the extracted before-copy", { err, out });
        return null;
    }
}

/**
 * `beforeCopy` for many files of one root: a file the capture lacks was clean when the command began, so it gets
 * `null` without calling `copy`. For a clone tree that costs one `lstat`; an older archive is listed once instead
 * of a `tar` spawn per file. `renamesIn` asks for every deleted file, and each one cost a `tar -xOf` even when
 * absent (up to `RENAME_SCAN_LIMIT` of them). `copy` is the read, a parameter so a test can count it.
 */
export function beforeCopier({
    dir,
    root,
    copy = beforeCopy,
}: {
    dir: string;
    root: string;
    copy?: typeof beforeCopy;
}): (absolute: string) => string | null {
    let capture: Capture | undefined;
    let members: Set<string> | null | undefined;

    return (absolute) => {
        if (capture === undefined) {
            capture = captureOf(dir, root);
        }

        if (capture === null) {
            return null;
        }

        const member = relative(root, absolute);

        if ("tree" in capture) {
            return inTree(capture.tree, member) === null ? null : copy({ dir, root, absolute });
        }

        if (members === undefined) {
            members = archiveMembers(capture.tar);
        }

        // An archive that could not be listed falls back to one extraction per file.
        if (members !== null && !members.has(member.normalize("NFC"))) {
            return null;
        }

        return copy({ dir, root, absolute });
    };
}

/** The archive's member names in NFC (bsdtar stores NFD, see `extract`), `null` when `tar -tf` failed. */
function archiveMembers(tar: string): Set<string> | null {
    const listed = spawnSync("tar", ["-tf", tar], { encoding: "utf8", maxBuffer: 16_000_000 });

    if (listed.status !== 0 || typeof listed.stdout !== "string") {
        hookDiag("Could not list the capture archive", { tar, status: listed.status });
        return null;
    }

    return new Set(
        listed.stdout
            .split("\n")
            .filter(Boolean)
            .map((name) => name.normalize("NFC"))
    );
}

/**
 * `--` before the member name, for the same reason the capture uses it: a repository file
 * named `-C` would otherwise be read by tar as an option.
 *
 * bsdtar (macOS, Windows) reads an extract operand as a PATTERN, so `app/[id].tsx` matched
 * nothing, the before-state came back empty, and the file's pre-existing contents were
 * blamed on the command. Escaping fixes bsdtar; GNU tar matches literally by default and
 * would take the backslashes literally, so the raw name is the fallback.
 */
function extractExact(tar: string, member: string): Buffer | null {
    const extractOne = (name: string) => spawnSync("tar", ["-xOf", tar, "--", name], { maxBuffer: 16_000_000 });
    const escaped = member.replace(/[\\*?[\]]/g, "\\$&");
    let run = extractOne(escaped);

    if (run.status !== 0 && escaped !== member) {
        run = extractOne(member);
    }

    return run.status === 0 && run.stdout !== null ? run.stdout : null;
}

/**
 * 🛑 git and macOS `tar` disagree about Unicode, so the name git gives is not the name the
 * archive holds.
 *
 * Measured 2026-09-21 on a note whose directory name starts with `Č`: git reports NFC
 * (`U+010C`), bsdtar stores NFD (`C` + `U+030C`). `tar -xOf` with the NFC name exits 1 with no
 * output; with the NFD name it returns all 54 KB. The archive LISTS a name that prints
 * identically to the one that fails, so the mismatch is invisible by eye.
 *
 * The consequence was not a missing diff: `beforeCopy` returning null makes an untracked file
 * render against `/dev/null`, so every accented note printed in full, as `Added`, on every
 * single command. Observed nine times on one file across two sessions.
 *
 * Both normal forms are tried before the archive is listed, because the listing costs a third
 * process and the NFD form answers it on this platform. An ASCII member never gets past the
 * first attempt, so the common path is unchanged.
 */
function extract(tar: string, member: string): Buffer | null {
    const exact = extractExact(tar, member);

    if (exact !== null) {
        return exact;
    }

    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to detect any byte outside ASCII
    if (!/[^\u0000-\u007F]/.test(member)) {
        // An ASCII member that is absent is the NORMAL case: the file was clean when the
        // command began, so git itself holds its before-state.
        return null;
    }

    for (const form of ["NFD", "NFC"] as const) {
        const renamed = member.normalize(form);

        if (renamed !== member) {
            const found = extractExact(tar, renamed);

            if (found !== null) {
                return found;
            }
        }
    }

    // Any other rewriting the archiver may do: match on the listing, comparing in one form.
    const listed = spawnSync("tar", ["-tf", tar], { encoding: "utf8", maxBuffer: 16_000_000 });

    if (listed.status !== 0 || typeof listed.stdout !== "string") {
        return null;
    }

    const wanted = member.normalize("NFC");
    const stored = listed.stdout.split("\n").find((name) => name.normalize("NFC") === wanted);

    return stored ? extractExact(tar, stored) : null;
}
