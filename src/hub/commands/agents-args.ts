import { parseDuration } from "@genesiscz/utils/format";
import { InvalidArgumentError } from "commander";

/**
 * The `--since` / `--limit` parsers of the agents tree, apart from the command so a CLI that only
 * registers the flags (`tools ai sessions subagents`) does not import the tree's provider stack.
 */
export function hoursArg(value: string): number {
    const ms = parseDuration(value);
    if (ms <= 0) {
        throw new InvalidArgumentError("a duration: 90m, 24h, 7d");
    }

    return ms / 3_600_000;
}

export function limitArg(value: string): number {
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1) {
        throw new InvalidArgumentError("a whole number above 0");
    }

    return limit;
}
