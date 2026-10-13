import { profiler } from "@genesiscz/utils/profile";
import { git } from "./build.ts";

const prof = profiler.scope("sourcemaps");

export interface DiffHunk {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
}

/** The `@@ -a,b +c,d @@` headers of a zero-context diff. */
export function parseHunks(diff: string): DiffHunk[] {
    const hunks: DiffHunk[] = [];
    for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
        hunks.push({
            oldStart: Number(match[1]),
            oldCount: match[2] === undefined ? 1 : Number(match[2]),
            newStart: Number(match[3]),
            newCount: match[4] === undefined ? 1 : Number(match[4]),
        });
    }

    return hunks;
}

/**
 * Where line `line` of the old file is in the new file. `changed` is true when that line itself was edited or
 * deleted; the result is then the start of the replacing hunk.
 */
export function translateThroughHunks(hunks: DiffHunk[], line: number): { line: number; changed: boolean } {
    let shift = 0;
    for (const hunk of hunks) {
        // git numbers an empty side by the line BEFORE it: `-a,0` inserts after old line a, `+c,0` deletes so
        // that new line c is the last line before the gap.
        const firstAffected = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart;
        if (line < firstAffected) {
            break;
        }

        if (hunk.oldCount > 0 && line < hunk.oldStart + hunk.oldCount) {
            const replaced =
                hunk.newCount === 0
                    ? hunk.newStart + 1
                    : hunk.newStart + Math.min(line - hunk.oldStart, hunk.newCount - 1);
            return { line: replaced, changed: true };
        }

        const firstNewAfter = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart + hunk.newCount;
        const firstOldAfter = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart + hunk.oldCount;
        shift = firstNewAfter - firstOldAfter;
    }

    return { line: line + shift, changed: false };
}

/** Translates source lines from one commit's version of a file to another's, with one `git diff` per file. */
export class LineTranslator {
    private readonly diffs = new Map<string, Promise<DiffHunk[] | null>>();

    constructor(private readonly options: { repo: string; from: string; to: string }) {}

    get identity(): boolean {
        return this.options.from === this.options.to;
    }

    private hunks(path: string): Promise<DiffHunk[] | null> {
        let pending = this.diffs.get(path);
        if (!pending) {
            pending = prof.measureAsync("line-translate.diff", () =>
                git(this.options.repo, [
                    "diff",
                    "-U0",
                    "--no-renames",
                    "--no-color",
                    this.options.from,
                    this.options.to,
                    "--",
                    path,
                ]).then(
                    (diff) => (diff.includes("deleted file mode") ? null : parseHunks(diff)),
                    () => null
                )
            );
            this.diffs.set(path, pending);
        }

        return pending;
    }

    /** Null when the file does not exist at the target commit. */
    async translate(path: string, line: number): Promise<{ line: number; changed: boolean } | null> {
        if (this.identity) {
            return { line, changed: false };
        }

        const hunks = await this.hunks(path);
        return hunks ? translateThroughHunks(hunks, line) : null;
    }
}
