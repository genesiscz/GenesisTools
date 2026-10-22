import { toolCommand } from "@genesiscz/utils/cli/tool-command";

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
