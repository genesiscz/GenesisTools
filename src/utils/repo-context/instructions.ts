import { joinRelative } from "./gather";
import type { ContextGatherer } from "./types";

/**
 * Agent guidance a coding agent should read before editing near a returned file. Looked up in the
 * root and in every ancestor of every target, in this order per directory. Dot names are found only
 * when the caller's reader looks at dot paths; a reader that skips them is not "incomplete".
 */
export const INSTRUCTION_FILE_NAMES = [
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    ".cursorrules",
    ".windsurfrules",
] as const;
/** Conventions that live only at the root. */
export const ROOT_INSTRUCTION_FILES = [".github/copilot-instructions.md"] as const;

export interface InstructionFiles {
    files: string[];
    /** A lookup failed, or a file is there but the policy withholds it: the list may be short. */
    incomplete: boolean;
}

export function instructionFilesGatherer(
    options: { names?: readonly string[]; rootFiles?: readonly string[] } = {}
): ContextGatherer<"instructions", InstructionFiles> {
    const names = options.names ?? INSTRUCTION_FILE_NAMES;
    const rootFiles = options.rootFiles ?? ROOT_INSTRUCTION_FILES;
    return {
        id: "instructions",
        async gather({ reader, directories }) {
            const candidates = directories.flatMap((directory) => [
                ...names.map((name) => joinRelative(directory, name)),
                ...(directory === "." ? rootFiles : []),
            ]);
            const lookups = await Promise.all(
                candidates.map(async (path) => ({ path, found: await reader.lookup(path) }))
            );
            return {
                files: lookups.filter(({ found }) => found === "file").map(({ path }) => path),
                incomplete: lookups.some(({ found }) => found === "withheld" || found === "unreadable"),
            };
        },
    };
}
