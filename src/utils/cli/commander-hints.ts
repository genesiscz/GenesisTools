import { levenshteinDistance } from "@genesiscz/utils/fuzzy-match";
import type { Command } from "commander";

/** How far a typed name may be from a command for a "Did you mean" hint (commander's own limit). */
const HINT_DISTANCE = 2;

/**
 * An unknown subcommand gets its "Did you mean" hint only from `safe`, the commands that change nothing. Commander's
 * own hint takes the nearest name of all: `tools recorder show` suggested `stop`, `stat` suggested `start`, and `stop`
 * without an id stops the newest recording, which can be another session's (round 2, 2026-11-07).
 */
export function suggestOnlySafeCommands(program: Command, safe: readonly string[]): void {
    program.on("command:*", (operands: string[]) => {
        const typed = operands[0] ?? "";
        let best: { name: string; distance: number } | undefined;

        for (const name of safe) {
            const distance = levenshteinDistance(typed, name);

            if (distance <= HINT_DISTANCE && (!best || distance < best.distance)) {
                best = { name, distance };
            }
        }

        const hint = best ? `\n(Did you mean ${best.name}?)` : "";
        program.error(`error: unknown command '${typed}'${hint}`, { code: "commander.unknownCommand" });
    });
}

/**
 * Every subcommand takes `--json`, the ones without their own as a flag that changes nothing: an agent adds it by
 * habit, and an unknown option stopped the command (round 2, 2026-11-07). A command's own `--json` stays as it is.
 */
export function acceptJsonEverywhere(program: Command, description: string): void {
    for (const command of program.commands) {
        if (!command.options.some((option) => option.long === "--json")) {
            command.option("--json", description);
        }

        acceptJsonEverywhere(command, description);
    }
}
