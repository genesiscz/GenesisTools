import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { CmdToolVerb, TransclusionHints } from "@genesiscz/utils/transclude";

/**
 * Every GenesisTools command that a shared module under `src/utils` shows or runs, in one place.
 *
 * A util never imports this file. A GenesisTools command, MCP server or other entry point calls one of these and
 * passes the result into the util as an option, so a copy of the util in another repo, where `toolCommand()` names
 * a different binary, gets no hint and prints none. lint-rules `no-tool-command-in-utils` allows a `tools …`
 * command under `src/utils` only here (and in the files its ratchet list still names).
 */

/** The command json2md writes into a document's stamp, so a reader can rebuild it. */
export function json2mdBuild(portable: string): string {
    return `${toolCommand("json2md build")} ${portable}`;
}

/** The argv that speaks a notification's message aloud; the message is appended as the last word. */
export function notificationSayCommand(): string[] {
    return toolCommand("say").split(" ");
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
