import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { type CloudPlaceholderKind, cloudPlaceholderKind } from "@genesiscz/utils/fs/cloud-placeholder";

/** A compression this module will not run, and why; nothing was written. */
export class CompressRefusal extends Error {}

export interface SourceScan {
    bytes: number;
    /** Cloud placeholders, relative to the source folder (the file's name for a single file). */
    placeholders: Array<{ path: string; kind: CloudPlaceholderKind }>;
}

/**
 * The bytes a compression reads and the cloud placeholders among them, from `lstat` and one xattr lookup per file:
 * the whole folder, only `files` of it, or the one file. Nothing is opened, so no placeholder downloads.
 */
export function scanSource(source: string, files?: readonly string[]): SourceScan {
    const scan: SourceScan = { bytes: 0, placeholders: [] };
    const visit = (absolute: string, path: string) => {
        // The source itself is followed, as the compression reads it; entries inside are not, as tar packs them.
        const stat = path === "" ? statSync(absolute) : lstatSync(absolute);

        if (stat.isDirectory()) {
            for (const name of readdirSync(absolute)) {
                visit(join(absolute, name), path === "" ? name : `${path}/${name}`);
            }

            return;
        }

        scan.bytes += stat.size;
        // The xattr and flag lookups do not follow a symlink, so a followed source is asked about its target.
        const kind = cloudPlaceholderKind(path === "" ? realpathSync(absolute) : absolute, stat);

        if (kind) {
            scan.placeholders.push({ path: path === "" ? basename(absolute) : path, kind });
        }
    };

    if (files) {
        for (const file of files) {
            visit(join(source, file), file);
        }
    } else {
        visit(source, "");
    }

    return scan;
}

/** The refusal for a source with cloud placeholders: up to 20 names, then a count, and what each kind means. */
export function placeholderRefusal(source: string, placeholders: SourceScan["placeholders"]): string {
    const names = placeholders
        .map((placeholder) => placeholder.path)
        .sort()
        .slice(0, 20);
    const more = placeholders.length - names.length;
    const stubs = placeholders.filter((placeholder) => placeholder.kind === "dropbox-stub").length;
    const kinds = [
        stubs > 0 ? `${stubs} with the com.dropbox.placeholder xattr, whose bytes here are zeros` : "",
        placeholders.length - stubs > 0
            ? `${placeholders.length - stubs} dataless (the SF_DATALESS flag), which a read would download`
            : "",
    ].filter(Boolean);
    return `${source} holds ${placeholders.length} cloud placeholder${placeholders.length === 1 ? "" : "s"} (${kinds.join("; ")}): ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}. Their real content lives in the cloud copy, so nothing was written. Pass --include-placeholders to pack them as they are`;
}
