import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
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
}

/** Writes the call's full diff as markdown and returns its path, or `null` when it could not. */
export function writeFullDiff(options: {
    toolUseId: string | undefined;
    command: string;
    parts: FullDiffPart[];
    notShown: string[];
}): string | null {
    const call = safeSegment(options.toolUseId);

    if (call === null) {
        return null;
    }

    const fence = "```";
    const command = options.command.trim();
    const sections = [
        `# Diff of ${call}`,
        "",
        `${new Date().toLocaleString("sv-SE")}`,
        "",
        `${fence}sh`,
        command.length > 4000 ? `${command.slice(0, 4000)}\n…` : command,
        fence,
        "",
        ...options.parts.flatMap((part) => [`## ${part.label}`, "", `${fence}diff`, part.patch.trimEnd(), fence, ""]),
        ...(options.notShown.length > 0
            ? ["## Changed, past the file cap", "", ...options.notShown.map((path) => `- ${path}`), ""]
            : []),
    ];
    const path = join(fullDiffDir(), `${call}.md`);

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

    // `encodeURI` keeps the slashes and encodes spaces and non-ASCII letters, which is what the
    // Genesis router expects in `path=`.
    const target = mode === "genesis" ? `https://genesis.tools/md/open?path=${encodeURI(path)}` : path;

    return `Full diff: ${target}`;
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
