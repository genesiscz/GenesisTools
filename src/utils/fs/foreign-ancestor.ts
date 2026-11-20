import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { aclAllows } from "./acl";

/**
 * Why another local user could swap `path` for a file or folder of theirs, or null. A path is only as private as
 * everything above it: whoever can write to a folder on the way can rename what is below it and put their own
 * there. So every folder and symlink on the way must be this user's or root's, and a folder others can write
 * needs the sticky bit (as /tmp has), which keeps them from renaming what they do not own. On macOS a folder
 * whose access control list allows anybody anything is refused too: such an entry can give write access that the
 * mode does not show. A symbolic link on the way is followed hop by hop, and every folder that a hop goes through
 * is held to the same rule. `path` has to exist.
 */
export function foreignAncestor(path: string): string | null {
    const uid = process.getuid?.();

    // No POSIX owners or modes to read (Windows).
    if (uid === undefined) {
        return null;
    }

    const problem = (at: string, info: { uid: number; mode: number }, folder: boolean): string | null => {
        if (info.uid !== uid && info.uid !== 0) {
            return `${at} belongs to another user, who could swap the folder below it`;
        }

        if (folder && (info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) {
            return `${at} can be changed by other users, who could swap the folder below it`;
        }

        if (folder && aclAllows(at) !== false) {
            return `${at} has an access control list that may let other users change it, who could swap the folder below it`;
        }

        return null;
    };

    const links: string[] = [];

    // The path as written (a symlinked /tmp, a planted date folder), then the real folders it leads to.
    for (let at = dirname(path); ; at = dirname(at)) {
        const entry = lstatSync(at);
        const found = problem(at, entry, entry.isDirectory());

        if (found) {
            return found;
        }

        if (entry.isSymbolicLink()) {
            links.push(at);
        }

        if (at === dirname(at)) {
            break;
        }
    }

    for (let at = dirname(realpathSync(path)); ; at = dirname(at)) {
        const found = problem(at, statSync(at), true);

        if (found) {
            return found;
        }

        if (at === dirname(at)) {
            break;
        }
    }

    // What each symbolic link names, hop by hop: a link may lead through other links before it reaches the real
    // folders checked above, and whoever can change a folder on that way can point the path somewhere else.
    const seen = new Set<string>();

    const hop = (start: string): string | null => {
        for (let at = start; !seen.has(at); at = dirname(at)) {
            seen.add(at);
            const entry = lstatSync(at);
            const found = problem(at, entry, entry.isDirectory()) ?? (entry.isSymbolicLink() ? hop(named(at)) : null);

            if (found) {
                return found;
            }
        }

        return null;
    };

    for (const link of links) {
        const found = hop(named(link));

        if (found) {
            return found;
        }
    }

    return null;
}

/** The path a symbolic link names. A relative one is read from the real folder that holds the link. */
function named(link: string): string {
    return resolve(realpathSync(dirname(link)), readlinkSync(link));
}
