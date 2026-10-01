import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { hookDiag } from "../log";

const DIR_MODE = 0o700;

/**
 * Creates `dir` and proves that every directory from `tmpdir()` down to it is a plain directory
 * owned by this user. Setting 0700 on the leaf alone was not enough on a shared `/tmp`: another
 * user could pre-create `GenesisTools/...` or plant a symlink in the chain, and the copies of
 * dirty files would land in a tree that user controls. Returns the reason it refused, or `null`.
 */
export function makePrivateDir(dir: string): string | null {
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

/**
 * A file this user may write in a private tree: refuses one that exists as a symlink or as anything but a
 * plain file this user owns, since an append or write would follow it. Returns the reason, or `null`.
 */
export function refuseUnsafeLeaf(path: string): string | null {
    let stat: ReturnType<typeof lstatSync>;

    try {
        stat = lstatSync(path);
    } catch {
        // Not there yet: the write creates it, mode 0600.
        return null;
    }

    if (stat.isSymbolicLink() || !stat.isFile()) {
        return `${path} is not a plain file`;
    }

    const uid = process.getuid?.();
    return uid !== undefined && stat.uid !== uid ? `${path} belongs to uid ${stat.uid}, not to this user` : null;
}

/** `makePrivateDir` for the file's folder and `refuseUnsafeLeaf` for the file; throws the reason it refused. */
export function assertPrivateFile(path: string): void {
    const refused = makePrivateDir(dirname(path)) ?? refuseUnsafeLeaf(path);

    if (refused) {
        throw new Error(refused);
    }
}
