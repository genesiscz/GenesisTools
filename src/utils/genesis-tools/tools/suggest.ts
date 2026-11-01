import { suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli/executor";

/**
 * The GenesisTools command lines built from the current argv with `suggestCommand()`. The executor loads the logger
 * and commander, so only the utils that already import it use this file; every other command is in the sibling files
 * built with `toolCommand()` alone.
 */

/** The current history command with `--all` added. */
export function historyAllCommand(toolName: string): string {
    return suggestCommand(`tools ${toolName} history`, { add: ["--all"] });
}

/** The possible history `--format` values and the current history command with the first one filled in. */
export function historyFormatFlagHint(toolName: string, formats: readonly string[], given?: string): string {
    return suggestEnumFlag(`tools ${toolName} history`, "--format", formats, { subcommand: ["history"], given });
}

/** The possible Jev providers and the current command with the first one filled in. */
export function jevProviderFlagHint(providers: readonly string[]): string {
    return suggestEnumFlag("tools jev", "--provider", providers);
}

/** Sets TypeSafe as the Jev provider. */
export function jevConfigSetProviderTypesafeCommand(): string {
    return suggestCommand("tools jev", { replaceCommand: ["config", "set", "provider", "typesafe"] });
}

/** The current command with `--force` added. */
export function currentCommandWithForce(): string {
    return suggestCommand("tools", { add: ["--force"] });
}
