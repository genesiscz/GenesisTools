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
export function beforeCopy(dir: string, root: string, absolute: string): string | null {
    const rootsFile = join(dir, "roots.txt");

    if (!existsSync(rootsFile)) {
        return null;
    }

    const index = readFileSync(rootsFile, "utf8").split("\n").filter(Boolean).indexOf(root);

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
    //
    // `--` before the member name, for the same reason the capture uses it: a repository file
    // named `-C` would otherwise be read by tar as an option.
    const member = relative(root, absolute);
    const run = spawnSync("tar", ["-xOf", tar, "--", member], { maxBuffer: 16_000_000 });

    if (run.status !== 0 || run.stdout === null) {
        return null;
    }

    const out = join(dir, `before-${Bun.hash(absolute).toString(36)}`);

    try {
        writeFileSync(out, run.stdout, { mode: FILE_MODE });
        return out;
    } catch (err) {
        hookDiag("Could not write the extracted before-copy", { err, out });
        return null;
    }
}
