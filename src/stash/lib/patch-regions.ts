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
    for (const line of patch.split("\n")) {
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
            const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
            if (!header || !filePath) {
                throw new Error("Cannot recover stash hunk without its path and range");
            }
            current = {
                filePath,
                oldStart: Number(header[1]),
                newStart: Number(header[2]),
                newLines: Number(header[3] ?? 1),
                preImage: [],
                postImage: [],
                oldNoNewline: false,
                deletedFile,
            };
            hunks.push(current);
        } else if (current) {
            const prefix = line[0];
            if (prefix === " " || prefix === "-") {
                current.preImage.push(line.slice(1));
            }
            if (prefix === " " || prefix === "+") {
                current.postImage.push(line.slice(1));
            }
            if (line === "\\ No newline at end of file" && previousPrefix !== "+") {
                current.oldNoNewline = true;
            }
            previousPrefix = prefix ?? "";
        }
    }
    return hunks;
}
