export interface PatchHunk {
    filePath: string;
    oldStart: number;
    newStart: number;
    newLines: number;
    preImage: string[];
    postImage: string[];
    oldNoNewline: boolean;
    deletedFile: boolean;
}

/** Keep both images, including context, because apply markers wrap the entire hunk. */
export function patchHunks(patch: string): PatchHunk[] {
    const hunks: PatchHunk[] = [];
    let oldPath = "";
    let filePath = "";
    let deletedFile = false;
    let current: PatchHunk | undefined;
    let previousPrefix = "";
    // Lines still owed to the open hunk, from its header counts. While any are owed, a line is
    // content even when it reads "--- x" or "+++ x" (a removed "-- x" or an added "++ x").
    let oldLeft = 0;
    let newLeft = 0;
    for (const line of patch.split("\n")) {
        if (current && (oldLeft > 0 || newLeft > 0) && !/^[ +\-\\]/.test(line) && line !== "") {
            // Not a hunk line at all: the header counts were wrong, so stop owing lines.
            oldLeft = 0;
            newLeft = 0;
        }
        if (current && (oldLeft > 0 || newLeft > 0 || line.startsWith("\\"))) {
            // A context line whose single space was stripped arrives empty.
            const prefix = line === "" ? " " : line[0];
            if (prefix === " " || prefix === "-") {
                current.preImage.push(line.slice(1));
                oldLeft--;
            }
            if (prefix === " " || prefix === "+") {
                current.postImage.push(line.slice(1));
                newLeft--;
            }
            if (line === "\\ No newline at end of file" && previousPrefix !== "+") {
                current.oldNoNewline = true;
            }
            previousPrefix = prefix ?? "";
            continue;
        }
        if (line.startsWith("diff --git ")) {
            current = undefined;
        } else if (line.startsWith("--- ")) {
            oldPath = line.slice(4).replace(/^a\//, "");
            current = undefined;
        } else if (line.startsWith("+++ ")) {
            deletedFile = line === "+++ /dev/null";
            filePath = deletedFile ? oldPath : line.slice(4).replace(/^b\//, "");
            current = undefined;
        } else if (line.startsWith("@@ ")) {
            const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
            if (!header || !filePath) {
                throw new Error("Cannot recover stash hunk without its path and range");
            }
            oldLeft = Number(header[2] ?? 1);
            newLeft = Number(header[4] ?? 1);
            current = {
                filePath,
                oldStart: Number(header[1]),
                newStart: Number(header[3]),
                newLines: newLeft,
                preImage: [],
                postImage: [],
                oldNoNewline: false,
                deletedFile,
            };
            hunks.push(current);
            previousPrefix = "";
        }
    }
    return hunks;
}
