import { InvalidArgumentError } from "commander";

/**
 * Pick a single value from a set of mutually-exclusive flags.
 *
 * The chained-ternary pattern (`opts.a ? "a" : opts.b ? "b" : ...`) silently picks the first truthy
 * flag and ignores the others — `--staged --all` quietly becomes "staged" with no warning. This
 * helper makes the conflict explicit by throwing an InvalidArgumentError listing every conflicting
 * flag (commander formats it as a CLI usage error).
 *
 * Returns the single passed flag name, or `undefined` if none are set.
 */
export function pickExclusive(flags: Record<string, unknown>, names: readonly string[]): string | undefined {
    const set = names.filter((n) => flags[n]);
    if (set.length === 0) {
        return undefined;
    }
    if (set.length > 1) {
        throw new InvalidArgumentError(
            `flags --${set.join(", --")} are mutually exclusive; pass only one of --${names.join(", --")}`
        );
    }
    return set[0];
}

/**
 * Commander option parser for positive integers. Replaces ad-hoc `(v) => Number(v)` which silently
 * yields `NaN` for "abc" or `0` for "" and propagates as "latest"/missing — both confusing.
 */
export function parsePositiveInt(v: string): number {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) {
        throw new InvalidArgumentError(`must be a positive integer (got "${v}")`);
    }
    return n;
}
