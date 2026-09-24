import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

/**
 * Replaces a JSON config file in one rename, so a crash, a full disk or a reader in the middle of
 * the write never sees half a file. `settings.json` and `hooks.json` are both read by processes
 * that fall back to defaults on a parse error, which turns a torn write into a silent config loss.
 *
 * The rename lands on the link's TARGET: `~/.claude/settings.json` is often a symlink into a
 * dotfiles repository, and renaming over the link itself would swap it for a plain file.
 *
 * Not on the hook hot path: only the installer and the `config` commands write these files.
 */
export function writeJsonFile(path: string, value: unknown): void {
    atomicWriteFileSync(writeTarget(path), `${SafeJSON.stringify(value, null, 2)}\n`);
}

/**
 * The file a write to `path` must land on. `existsSync` follows links, so a DANGLING link (its
 * target not created yet) read as "no file" and the rename replaced the link itself. A link is
 * resolved even when its target is missing.
 */
function writeTarget(path: string): string {
    if (existsSync(path)) {
        return realpathSync(path);
    }

    try {
        if (lstatSync(path).isSymbolicLink()) {
            return resolve(dirname(path), readlinkSync(path));
        }
    } catch {
        // Nothing at `path` at all: the first write creates it there.
    }

    return path;
}
