import { lstatSync, readlinkSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, parse, sep } from "node:path";

/**
 * Reading the bytes of a cloud placeholder downloads it. A dataless file (Dropbox, Google Drive, OneDrive, the
 * Tresorit Drive mount, iCloud Drive, Desktop and Documents in iCloud) keeps only its metadata on disk, and the first
 * `read` makes the kernel ask the File Provider for the content before the call returns. A `stat` is safe; a copy,
 * a hash or a `tar` is not. Measured 2026-11-01 17:08: the Bash diff hook copied two Dropbox placeholders that an
 * `ls` named, both lost their dataless flag, and the FileProvider log showed the request before the command ran.
 */

/** `~/Library/CloudStorage/<provider>` (File Provider apps) and `~/Library/Mobile Documents` (iCloud Drive). */
const CLOUD_ROOT = /[/\\]Library[/\\](?:CloudStorage|Mobile Documents)(?:[/\\]|$)/;

/** Links followed before the walk gives up, as the kernel does with ELOOP (MAXSYMLINKS is 32 on macOS). */
const MAX_LINKS = 32;

const SEPARATOR = /[/\\]/;

/**
 * Whether `path` lies under a folder a File Provider serves, where any read may reach the provider. Both the path as
 * written and the file it reaches through symlinks and `..` are checked: `~/Dropbox` is a link into
 * `~/Library/CloudStorage`, and `stat`, `copyFileSync` and `git` all follow it.
 */
export function underCloudRoot(path: string): boolean {
    if (CLOUD_ROOT.test(path)) {
        return true;
    }

    const target = resolvedTarget(path);

    return target !== null && CLOUD_ROOT.test(target);
}

/**
 * The real path of `path`, found with `lstat` and `readlink` alone, or `null` when a component is missing or the links
 * loop. Not `realpathSync`: Bun's opens the target (a mode 000 file fails it with EACCES, Bun 1.4.2, 2026-11-01), and
 * this check exists so that the file is never opened.
 */
function resolvedTarget(path: string): string | null {
    const start = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
    let current = parse(start).root;
    let pending = start.slice(current.length).split(SEPARATOR);
    let links = 0;

    while (pending.length > 0) {
        const [part = "", ...rest] = pending;
        pending = rest;

        if (part === "" || part === ".") {
            continue;
        }

        // `current` holds no link by now, so its parent is the real parent, as the kernel walks it.
        if (part === "..") {
            current = dirname(current);
            continue;
        }

        const next = join(current, part);
        const link = linkOf(next);

        if (link === undefined) {
            return null;
        }

        if (link === null) {
            current = next;
            continue;
        }

        links += 1;

        if (links > MAX_LINKS) {
            return null;
        }

        // An absolute target starts again at its root; a relative one continues from the link's folder.
        const root = isAbsolute(link) ? parse(link).root : "";

        if (root.length > 0) {
            current = root;
        }

        pending = [...link.slice(root.length).split(SEPARATOR), ...pending];
    }

    return current;
}

/** The target of `path` when it is a symlink, `null` when it is not one, `undefined` when it cannot be read. */
function linkOf(path: string): string | null | undefined {
    try {
        return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
    } catch {
        return undefined;
    }
}

/**
 * A file with bytes but no blocks: its content is not on this disk. Node exposes no `st_flags`, so `SF_DATALESS`
 * cannot be read here; zero blocks is its visible half. The same test also matches a sparse all-zero file and a file
 * stored compressed in its extended attributes, which costs those only a skipped read. macOS only: Windows reports
 * no blocks, and no placeholder there looks like this.
 */
export function isDatalessFile(stat: Pick<Stats, "size" | "blocks">): boolean {
    if (process.platform !== "darwin") {
        return false;
    }

    return stat.size > 0 && stat.blocks === 0;
}

/** Why reading `path` could download it from a cloud provider, or `null` when a read stays local. */
export function cloudReadRisk(path: string, stat: Pick<Stats, "size" | "blocks">): string | null {
    if (underCloudRoot(path)) {
        return "under a cloud storage folder, where a read can download it";
    }

    if (isDatalessFile(stat)) {
        return `${stat.size} bytes in 0 blocks, a cloud placeholder that a read would download`;
    }

    return null;
}
