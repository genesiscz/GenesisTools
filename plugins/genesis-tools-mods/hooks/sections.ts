/** One file of a diff-hook full-diff note: its path, its line counts and its unified-diff hunks. */
export interface Section {
    path: string;
    added: number;
    removed: number;
    patch: string;
}

export interface CallSection extends Section {
    call: string;
}

/**
 * The files of `~/.genesis-tools/agents/hook-diffs/<call>.md`, which `tools agents hooks` writes when
 * a message cuts lines: `## <path> (+a -b)`, a blank line, then the hunks in a ```diff fence.
 */
const SECTION = /^## (.+?) \(\+(\d+) -(\d+)\)\n\n```diff\n([\s\S]*?)\n```$/gm;

/**
 * The hunks only. The note's fence starts with git's `diff --git` and `index` lines, which the Code
 * element's diff parser is not documented to read past (it reads past `---` and `+++`), so the patch
 * starts at the first hunk header.
 */
function hunksOf(patch: string): string {
    const at = patch.search(/^@@ /m);

    return at < 0 ? "" : patch.slice(at);
}

export function sectionsOf(text: string): Section[] {
    return [...text.matchAll(SECTION)]
        .map((match) => ({
            path: match[1] ?? "",
            added: Number(match[2]),
            removed: Number(match[3]),
            patch: hunksOf(match[4] ?? ""),
        }))
        .filter((section) => section.patch.length > 0);
}

/**
 * The sections of several calls' notes, in call order, while their patches fit `maxChars` together.
 * A call with no note (the hook did not cut its message, or it changed nothing) adds nothing.
 */
export async function sectionsOfCalls({
    ids,
    read,
    maxChars,
}: {
    ids: readonly string[];
    read: (id: string) => Promise<string>;
    maxChars: number;
}): Promise<CallSection[]> {
    const found: CallSection[] = [];
    let spent = 0;

    for (const call of ids) {
        let note: string;

        try {
            note = await read(call);
        } catch {
            continue;
        }

        for (const section of sectionsOf(note)) {
            spent += section.patch.length;

            if (spent > maxChars) {
                return found;
            }

            found.push({ ...section, call });
        }
    }

    return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/**
 * `mods.fullDiff` from the hooks file (`~/.genesis-tools/agents/hooks.json`), which
 * `tools agents hooks config set mods.fullDiff false` writes. A file that is missing, unreadable or
 * not JSON, and a value that is not a boolean, leave the default: on.
 */
export function fullDiffEnabled(hooksFile: string | undefined): boolean {
    if (hooksFile === undefined) {
        return true;
    }

    try {
        const stored: unknown = JSON.parse(hooksFile);
        const mods = isRecord(stored) ? stored.mods : undefined;
        const value = isRecord(mods) ? mods.fullDiff : undefined;

        return typeof value === "boolean" ? value : true;
    } catch {
        return true;
    }
}
