import { InvalidArgumentError } from "commander";

/**
 * Commander option parser factory for positive integers.
 * Throws `InvalidArgumentError` (commander handles printing the message) on:
 *   - non-numeric input (`"abc"` → NaN)
 *   - non-integers (`"1.5"`)
 *   - zero or negative values
 *
 * Usage:
 *   .option("--limit <n>", "...", parsePositiveInt("--limit"))
 */
export function parsePositiveInt(flag: string): (raw: string) => number {
    return (raw: string): number => {
        const trimmed = raw.trim();
        if (!/^[1-9]\d*$/.test(trimmed)) {
            throw new InvalidArgumentError(`${flag} must be a positive integer (got "${raw}")`);
        }

        return Number.parseInt(trimmed, 10);
    };
}
