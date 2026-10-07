import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * `[File.ts:91](file:///abs/File.ts#L91)`, the link form a terminal renders as clickable. The label
 * always carries a line; without a known line it points at line 1.
 */
export function fileLink(absPath: string, line?: number | null): string {
    const at = line && line > 0 ? line : 1;
    // pathToFileURL, not "file://" + path: a Windows path needs "/C:/…" with forward slashes, and "?" or "#" must not end the path
    const target = pathToFileURL(resolve(absPath)).href;

    return `[${basename(absPath)}:${at}](${target}#L${at})`;
}
