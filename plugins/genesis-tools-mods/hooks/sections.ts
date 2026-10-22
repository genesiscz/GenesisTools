import { isRecord, modsSettings } from "./settings";

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

export interface CallSections {
    sections: CallSection[];
    /**
     * The calls with a file past the budget, drawn in part or not at all. The hook checks each call's size on its own
     * and drops its full-diff link when that fits, so a group of two 40,000-character calls lost the second one
     * without a trace; the mod names these calls' notes instead.
     */
    omitted: string[];
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
}): Promise<CallSections> {
    const sections: CallSection[] = [];
    const omitted: string[] = [];
    let spent = 0;
    let full = false;

    for (const call of ids) {
        let note: string;

        try {
            note = await read(call);
        } catch {
            continue;
        }

        for (const section of sectionsOf(note)) {
            if (!full && spent + section.patch.length <= maxChars) {
                spent += section.patch.length;
                sections.push({ ...section, call });
                continue;
            }

            full = true;
            omitted.push(call);
            break;
        }
    }

    return { sections, omitted };
}

/** `mods.diff.fullDiff` of the hooks file (the flat `mods.fullDiff` of before still counts); on by default. */
export function fullDiffEnabled(hooksFile: string | undefined): boolean {
    return modsSettings(hooksFile).diff.fullDiff;
}

/** `mods.diff.collapseGitSync` of the hooks file (the flat `mods.collapseGitSync` of before still counts). */
export function collapseGitSyncEnabled(hooksFile: string | undefined): boolean {
    return modsSettings(hooksFile).diff.collapseGitSync;
}

/** The command of a Bash call's input, or an empty string. */
export function commandOf(input: unknown): string {
    return isRecord(input) && typeof input.command === "string" ? input.command : "";
}

/**
 * `git` as the command word of a statement (after `;`, `&&`, `|`, `(` or a line start, and any `VAR=x` assignments),
 * then git's own leading options (`-C <dir>`, `-c <key=value>`, `--no-pager`), then the sync verb. `echo git pull`
 * runs no pull.
 */
const GIT_SYNC =
    /(?:^|[;&|(])[ \t]*(?:[A-Za-z_]\w*=\S*[ \t]+)*(?:\S*\/)?git(?:[ \t]+(?:-[Cc][ \t]+\S+|--?[A-Za-z][\w-]*(?:=\S+)?))*[ \t]+(pull|merge|rebase|checkout|switch|reset|cherry-pick|revert|am|stash[ \t]+(?:pop|apply))(?=$|[\s;&|)])/m;

/**
 * `git pull` (or `git merge`, `git stash pop`, …) when the command runs one, else `undefined`. Its diff is other
 * people's work arriving, so the mod starts it hidden behind one button (2026-10-20: a `git pull` in devulinka-infra
 * drew every pulled line). Heredoc bodies are dropped first and each quoted string becomes one word: `git commit -m
 * "after git pull"` runs no pull, and `git -C "/repo/a b" pull` keeps its folder as one argument.
 */
export function gitSyncOf(command: string): string | undefined {
    const bare = command
        .replace(/<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, " ")
        .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "Q");
    const verb = GIT_SYNC.exec(bare)?.[1];

    return verb === undefined ? undefined : `git ${verb.replace(/\s+/g, " ")}`;
}
