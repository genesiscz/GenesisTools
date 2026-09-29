import { type FileDiffMetadata, parseDiffFromFile } from "@pierre/diffs";

/** What the page parses of a file Swift sent (main.ts `BridgeFile`). */
export interface FileSides {
    path: string;
    oldPath: string | null;
    oldContents: string | null;
    newContents: string | null;
    /** Changes when either side's text changes; names the text for the workers' highlight cache. */
    key: string;
}

/**
 * The file's diff, named with the paths Swift sent. parseDiffFromFile writes the two texts as a patch
 * with jsdiff 9, which C-quotes a name outside printable ASCII in the `---` / `+++` lines (`Č` is
 * `"\304\214"`, and a `"` or `\` quotes the name too), and @pierre/diffs 1.4.3 reads the name back from
 * those lines without unquoting it. The header then showed the quoted text, and the fold and the
 * highlight language, which both go by the name, missed the file.
 */
export function parseFileDiff(file: FileSides): FileDiffMetadata {
    // A missing side (new or deleted file) is empty text: parseDiffFromFile's null path throws on
    // `.split` in 1.4.3 even though its types accept null.
    const oldName = file.oldPath ?? file.path;
    const fileDiff = parseDiffFromFile(
        { name: oldName, contents: file.oldContents ?? "", cacheKey: `${file.key}:old` },
        { name: file.path, contents: file.newContents ?? "", cacheKey: `${file.key}:new` }
    );
    fileDiff.name = file.path;

    // Set only for a rename: quoting keeps two different names different, so the type is right.
    if (fileDiff.prevName !== undefined) {
        fileDiff.prevName = oldName;
    }

    return fileDiff;
}
