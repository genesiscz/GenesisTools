import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { hookDiag } from "../log";

/** The extracted copy can hold secrets, exactly like the tar it came from. */
const FILE_MODE = 0o600;

/**
 * Writes the captured copy out so `git diff --no-index` can read it.
 *
 * `null` is a meaningful answer, not a failure: it means the file was CLEAN when the command
 * began, so it is absent from the tar and git itself holds the before-state. The caller falls
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
export function alreadyGone(dir: string, root: string, absolute: string): boolean {
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

export function leftOutOfCapture(dir: string, root: string, absolute: string): boolean {
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

export function beforeCopy(dir: string, root: string, absolute: string): string | null {
    const index = rootIndex(dir, root);

    if (index < 0) {
        return null;
    }

    const tar = join(dir, `${index + 1}.tar`);

    if (!existsSync(tar)) {
        return null;
    }

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
 * `--` before the member name, for the same reason the capture uses it: a repository file
 * named `-C` would otherwise be read by tar as an option.
 */
function extractExact(tar: string, member: string): Buffer | null {
    const run = spawnSync("tar", ["-xOf", tar, "--", member], { maxBuffer: 16_000_000 });

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
