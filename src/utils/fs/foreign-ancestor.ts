import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Why another local user could swap `path` for a file or folder of theirs, or null. A path is only as private as
 * everything above it: whoever can write to a folder on the way can rename what is below it and put their own
 * there. So every folder and symlink on the way must be this user's or root's, and a folder others can write
 * needs the sticky bit (as /tmp has), which keeps them from renaming what they do not own. `path` has to exist.
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

        return null;
    };

    // The path as written (a symlinked /tmp, a planted date folder), then the real folders it leads to.
    for (let at = dirname(path); ; at = dirname(at)) {
        const entry = lstatSync(at);
        const found = problem(at, entry, entry.isDirectory());

        if (found) {
            return found;
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
            return null;
        }
    }
}
