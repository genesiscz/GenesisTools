import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { routerLink } from "@genesiscz/utils/browser-router/router-link";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { redactSecretsInText } from "@genesiscz/utils/transclude/redact";
import { hookDiag } from "../log";
import { safeSegment } from "../paths";

/**
 * The whole diff of one call, for the lines the message had to cut. Claude Code prints a hook
 * message as fixed text, so "… 129 more lines" cannot unfold; the message links this file instead,
 * and `tools agents hooks diff show <call>` prints it.
 */

/** How the message points at the full diff: a Genesis viewer link, the bare path, or not at all. */
export const FULL_DIFF_MODES = ["genesis", "path", "off"] as const;
export type FullDiffMode = (typeof FULL_DIFF_MODES)[number];

/** Files older than this are removed at session end. */
const KEEP_MS = 7 * 24 * 3_600_000;

export function fullDiffDir(): string {
    return genesisToolsDir("agents", "hook-diffs");
}

export interface FullDiffPart {
    label: string;
    patch: string;
    /** The changed file, when `label` adds its counts. */
    path?: string;
}

/**
 * A file past the cap, headed `<path> (+a -b)` like a drawn block: the full-diff mod parses only that heading
 * (`plugins/genesis-tools-mods/hooks/sections.ts`), so a bare path heading was dropped from its view.
 */
export function overflowPart(path: string, patch: string): FullDiffPart {
    // Only rows inside a hunk count: an added source line that starts with `++` is `+++…` in the patch too.
    let added = 0;
    let removed = 0;
    let inHunk = false;

    for (const line of patch.split("\n")) {
        if (line.startsWith("@@")) {
            inHunk = true;
        } else if (line.startsWith("diff --git ")) {
            inHunk = false;
        } else if (inHunk && line.startsWith("+")) {
            added += 1;
        } else if (inHunk && line.startsWith("-")) {
            removed += 1;
        }
    }

    return { label: `${path} (+${added} -${removed})`, path, patch };
}

/** Writes the call's full diff as markdown and returns its path, or `null` when it could not. */
/**
 * The note of a background call written when its task ends: the mod draws `<call>.md` under that call's row, which a
 * finished task's diff already reaches through the hook's message, so this name keeps the mod from drawing it twice.
 * `diff show <call>` still finds it, by prefix.
 */
export const DEFERRED_NOTE_SUFFIX = ".task";

/**
 * The note of a call whose diff the hook's own message showed (the session has no mod mark): the mod draws only
 * `<call>.md`, so this name keeps any loaded copy of it from drawing the diff a second time. A session that loaded the
 * mod before the mark existed never sets it, and drew such calls twice (col-tools, 2026-10-23). `diff show <call>` still
 * finds it, by prefix.
 */
export const HOOK_NOTE_SUFFIX = ".hook";

export function writeFullDiff(options: {
    toolUseId: string | undefined;
    command: string;
    parts: FullDiffPart[];
    notShown: string[];
    deferred?: boolean;
    shownByHook?: boolean;
}): string | null {
    const call = safeSegment(options.toolUseId);

    if (call === null) {
        return null;
    }

    const fence = "```";
    // The patches come masked (`gitPatch` in run.ts); the command is masked here, because the note keeps it on disk
    // whatever `logCommands` and `diff.commandLines` say: `printf "ghp_…" > config.txt` saved the token in plain text.
    const command = redactSecretsInText(options.command.trim());
    const sections = [
        `# Diff of ${call}`,
        "",
        `${new Date().toLocaleString("sv-SE")}`,
        "",
        `${fence}sh`,
        command.length > 4000 ? `${command.slice(0, 4000)}\n…` : command,
        fence,
        "",
        // Trailing newlines only: a blank context line is a lone space, and `trimEnd()` cut it, which left the hunk a
        // line short of its header, so Claude Code drew the full-diff mod's copy as plain code (2026-10-19).
        ...options.parts.flatMap((part) => [
            `## ${part.label}`,
            "",
            `${fence}diff`,
            part.patch.replace(/\n+$/, ""),
            fence,
            "",
        ]),
        ...(options.notShown.length > 0
            ? ["## Changed, past the file cap", "", ...options.notShown.map((path) => `- ${path}`), ""]
            : []),
    ];
    const suffix = options.deferred ? DEFERRED_NOTE_SUFFIX : options.shownByHook ? HOOK_NOTE_SUFFIX : "";
    const path = join(fullDiffDir(), `${call}${suffix}.md`);

    try {
        mkdirSync(fullDiffDir(), { recursive: true, mode: 0o700 });
        writeFileSync(path, sections.join("\n"), { mode: 0o600 });
        return path;
    } catch (err) {
        hookDiag("Could not write the full diff", { err, path });
        return null;
    }
}

/** The line the message ends with, or `null` for mode `off`. */
export function fullDiffLine(path: string, mode: FullDiffMode): string | null {
    if (mode === "off") {
        return null;
    }

    if (mode === "path") {
        return `Full diff: ${path}`;
    }

    // A router that is off, or does not route Markdown, gets the plain path: a link it cannot open is
    // worse than none.
    const { result } = routerLink({ preset: "genesis-md", action: "open", data: { path }, fallback: () => path });

    return `Full diff: ${result}`;
}

/** The full diff of a call, by its id or a prefix of it. */
export function findFullDiff(id: string): string | null {
    try {
        const match = readdirSync(fullDiffDir()).find((name) => name.startsWith(id) && name.endsWith(".md"));
        return match ? join(fullDiffDir(), match) : null;
    } catch {
        return null;
    }
}

/** Removes full diffs older than a week; returns how many. Never throws. */
export function pruneFullDiffs(now: number): number {
    let removed = 0;

    try {
        for (const name of readdirSync(fullDiffDir())) {
            const path = join(fullDiffDir(), name);

            if (now - statSync(path).mtimeMs > KEEP_MS) {
                rmSync(path, { force: true });
                removed += 1;
            }
        }
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
            hookDiag("Could not prune the full diffs", { err });
        }
    }

    return removed;
}
