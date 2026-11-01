import type { Stats } from "node:fs";

/**
 * Reading the bytes of a cloud placeholder downloads it. A dataless file (Dropbox, Google Drive, OneDrive, the
 * Tresorit Drive mount, iCloud Drive, Desktop and Documents in iCloud) keeps only its metadata on disk, and the first
 * `read` makes the kernel ask the File Provider for the content before the call returns. A `stat` is safe; a copy,
 * a hash or a `tar` is not. Measured 2026-11-01 17:08: the Bash diff hook copied two Dropbox placeholders that an
 * `ls` named, both lost their dataless flag, and the FileProvider log showed the request before the command ran.
 */

/** `~/Library/CloudStorage/<provider>` (File Provider apps) and `~/Library/Mobile Documents` (iCloud Drive). */
const CLOUD_ROOT = /[/\\]Library[/\\](?:CloudStorage|Mobile Documents)(?:[/\\]|$)/;

/** Whether `path` lies under a folder a File Provider serves, where any read may reach the provider. */
export function underCloudRoot(path: string): boolean {
    return CLOUD_ROOT.test(path);
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
