import { basename, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface FileLinkOptions {
    /** The label shows the path relative to this folder; outside it, or without it, the file name. */
    root?: string;
    endLine?: number | null;
}

/**
 * `[src/File.ts:91-96](/abs/src/File.ts#L91-L96)`: a plain absolute path, because a terminal opens it and
 * a `file://` target does not open everywhere. Without a line there is no `:line` and no `#L`.
 */
export function fileLink(absPath: string, line?: number | null, options: FileLinkOptions = {}): string {
    const abs = resolve(absPath);
    // pathname of a file URL: "/C:/…" with forward slashes on Windows, and "?", "#" or a space stay inside the path
    const target = pathToFileURL(abs).pathname;
    const label = labelOf(abs, options.root);

    if (!line || line < 1) {
        return `[${label}](${target})`;
    }

    const end = options.endLine && options.endLine > line ? options.endLine : null;

    return end ? `[${label}:${line}-${end}](${target}#L${line}-L${end})` : `[${label}:${line}](${target}#L${line})`;
}

function labelOf(abs: string, root: string | undefined): string {
    if (!root) {
        return basename(abs);
    }

    const rel = relative(resolve(root), abs);

    return !rel || rel.startsWith("..") || isAbsolute(rel) ? basename(abs) : rel.split("\\").join("/");
}
