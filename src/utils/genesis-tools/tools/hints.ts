import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { spawnToolDetached } from "@genesiscz/utils/cli/tools";
import { formatCount } from "@genesiscz/utils/format";
import type { CmdToolVerb, TransclusionHints } from "@genesiscz/utils/transclude";

/**
 * This folder, `src/utils/genesis-tools/tools/`, is the one place under `src/utils` that names a GenesisTools command.
 * A util imports the function for the command it shows or runs from `@genesiscz/utils/genesis-tools/tools/<file>`
 * and calls it. `ai.ts`, `system.ts` and `services.ts` build their lines with `toolCommand()` alone, so importing one
 * loads nothing more; `suggest.ts` holds the lines built with `suggestCommand()`, for the utils that already load the
 * CLI executor. A copy of `src/utils` in another repository, whose binary is not `tools`, edits only this folder.
 * lint-rules `no-tool-command-in-utils` allows a `tools …` command under `src/utils` only in this folder.
 *
 * The functions in this file are passed by their GenesisTools caller into a util as an option (the json2md rebuild
 * command, the notification speaker, the transclusion hints). This file loads the process helpers, so a util imports
 * the lighter files above rather than this one.
 */

/** The command json2md writes into a document's stamp, so a reader can rebuild it. */
export function json2mdBuild(portable: string): string {
    return toolCommand("json2md build", portable);
}

/**
 * Speaks a notification's message through this checkout's `say` tool, by the shared runner rather than a `tools`
 * found on PATH (the main checkout), and detached, so the speech outlives a sender that exits right after posting.
 */
export function notificationSpeaker(spawn: (args: string[]) => unknown = spawnToolDetached): (message: string) => void {
    return (message) => {
        spawn(["say", message]);
    };
}

/** The command that reports whether a question's `[verify]` tokens changed since capture. */
export function questionShowRecheck(id = "<id>"): string {
    return `${toolCommand("question show")} ${id} --recheck`;
}

/** The shell line that re-resolves one token, single-quoted so a `"` inside it survives. */
export function questionTokensResolve(raw: string): string {
    return `${toolCommand("question tokens resolve")} '${raw.replace(/'/g, "'\\''")}'`;
}

/**
 * Read-only `tools` verbs the `cmd` token kind may run, matched on their leading words, each with the only flags it
 * may take. A verb with a writing flag (`git merged --prune`) is read-only only without it, so every other dash
 * argument is refused rather than a list of bad ones kept.
 */
export const CMD_TOOLS_VERBS: readonly CmdToolVerb[] = [
    {
        words: ["ts", "skeleton"],
        flags: [
            "--exported",
            "--top-level",
            "--types",
            "--include-names",
            "--include-hash",
            "--include-locals",
            "--function-context",
            "--exact-tokens",
            "--tests",
            "--ignore",
            "--format",
            "--md",
            "--json",
            "--json-compact",
            "--toon",
        ],
    },
    { words: ["git", "base"], flags: ["-b", "--base", "--offline", "--json", "-C", "--cwd"] },
    {
        words: ["git", "merged"],
        flags: ["-b", "--base", "--pr", "--json", "--all", "-d", "--stale-days", "-C", "--cwd"],
    },
    { words: ["question", "list"], flags: ["--type", "--all-sessions", "--session", "--status", "--json"] },
    { words: ["question", "tokens"], flags: ["--format", "--cwd"] },
];

/** Everything a GenesisTools transclusion registry names: pass it to `defaultTransclusionRegistry()`. */
export function transclusionHints(): TransclusionHints {
    return {
        verifyRecheck: questionShowRecheck(),
        recheck: questionTokensResolve,
        cmdTools: {
            program: toolCommand("ts skeleton").split(" ")[0],
            verbs: CMD_TOOLS_VERBS,
            description: `, ${toolCommand("ts skeleton")}, ${toolCommand("git base")}|merged, ${toolCommand("question list")}|tokens`,
            example: `{{cmd run="${toolCommand("ts skeleton")} src/utils/transclude/engine.ts"}}`,
        },
    };
}

/**
 * The one line an agent must pass on after `tools rm` opened a request. It stands alone: agents often keep only
 * `| tail -1` of the output, and a PostToolUse hook repeats it when the output was cut (`>/dev/null`).
 */
export function rmRequestHintLine(id: string, count: number): string {
    const rm = toolCommand("rm");
    return (
        `rm request ${id}: ${formatCount(count, "path")} ${count === 1 ? "waits" : "wait"} for the user. Do not run approve yourself. ` +
        `Open the user's window (in the background): ${rm} ask ${id}, or tell the user: ! ${rm} approve ${id}. ` +
        `Cancel your own: ${rm} deny ${id}`
    );
}

/** The command that turns an opt-in `tools rm` preset on, for the default rule's reason. */
export function rmEnablePresetCommand(id: string): string {
    return `${toolCommand("rm")} config set enable-preset ${id}`;
}
