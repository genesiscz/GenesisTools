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
    const seen = new Set<string>();

    return [...text.matchAll(SECTION)]
        .map((match) => ({
            path: match[1] ?? "",
            added: Number(match[2]),
            removed: Number(match[3]),
            patch: hunksOf(match[4] ?? ""),
        }))
        .filter((section) => {
            // A file the note holds twice (its block and its overflow part) is drawn once.
            const key = `${section.path}\n${section.patch}`;

            if (section.patch.length === 0 || seen.has(key)) {
                return false;
            }

            seen.add(key);
            return true;
        });
}

/** A file the call deleted whole: no line added, and its one hunk ends at line 0. */
export function isDeletion(section: Section): boolean {
    return section.added === 0 && /^@@ -\d+(?:,\d+)? \+0,0 @@/.test(section.patch);
}

/** A file over this many changed lines starts folded; so does every file once a row has opened this many. */
export const OPEN_FILE_LINES = 120;
export const OPEN_ROW_LINES = 300;

/**
 * Which files start open: not a whole deletion (its text is gone, the name says enough), not a file over
 * `OPEN_FILE_LINES`, and only while the row's open files stay within `OPEN_ROW_LINES`. A click on `[+]` opens
 * any of them (2026-10-18: a `git mv` call drew 1,300 deleted lines).
 */
export function openByDefault(sections: readonly Section[]): boolean[] {
    let open = 0;

    return sections.map((section) => {
        const lines = section.added + section.removed;

        if (isDeletion(section) || lines > OPEN_FILE_LINES || open + lines > OPEN_ROW_LINES) {
            return false;
        }

        open += lines;
        return true;
    });
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
 * A boolean of the `mods` section of the hooks file (`~/.genesis-tools/agents/hooks.json`), which
 * `tools agents hooks config set mods.<key> false` writes. A file that is missing, unreadable or not JSON,
 * and a value that is not a boolean, leave the default: on.
 */
function modsSwitch(hooksFile: string | undefined, key: "fullDiff" | "collapseGitSync"): boolean {
    if (hooksFile === undefined) {
        return true;
    }

    try {
        const stored: unknown = JSON.parse(hooksFile);
        const mods = isRecord(stored) ? stored.mods : undefined;
        const value = isRecord(mods) ? mods[key] : undefined;

        return typeof value === "boolean" ? value : true;
    } catch {
        return true;
    }
}

export function fullDiffEnabled(hooksFile: string | undefined): boolean {
    return modsSwitch(hooksFile, "fullDiff");
}

export function collapseGitSyncEnabled(hooksFile: string | undefined): boolean {
    return modsSwitch(hooksFile, "collapseGitSync");
}

/** The command of a Bash call's input, or an empty string. */
export function commandOf(input: unknown): string {
    return isRecord(input) && typeof input.command === "string" ? input.command : "";
}

const GIT_SYNC =
    /(?:^|[\s;&|(])git(?:\s+-C\s+\S+)?\s+(pull|merge|rebase|checkout|switch|reset|cherry-pick|revert|am|stash\s+(?:pop|apply))(?=$|[\s;&|)])/m;

/**
 * `git pull` (or `git merge`, `git stash pop`, …) when the command runs one, else `undefined`. Its diff is other
 * people's work arriving, so the mod starts it hidden behind one button (2026-10-20: a `git pull` in devulinka-infra
 * drew every pulled line). Heredoc bodies and quoted text are dropped first: `git commit -m "after git pull"` runs
 * no pull.
 */
export function gitSyncOf(command: string): string | undefined {
    const bare = command
        .replace(/<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, " ")
        .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, " ");
    const verb = GIT_SYNC.exec(bare)?.[1];

    return verb === undefined ? undefined : `git ${verb.replace(/\s+/g, " ")}`;
}
