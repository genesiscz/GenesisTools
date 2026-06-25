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
 * Commander option parser for positive integers. Strict decimal-only — `Number()` would otherwise
 * accept hex (`0x10`), scientific (`1e2`), binary (`0b11`), and signed forms, none of which make
 * sense as a CLI version pin. PR #222 t30: `--at 1e2` quietly became v100; now it errors.
 */
export function parsePositiveInt(v: string): number {
    const trimmed = v.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) {
        throw new InvalidArgumentError(`must be a positive decimal integer (got "${v}")`);
    }
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(n)) {
        throw new InvalidArgumentError(`must be a safe integer (got "${v}")`);
    }
    return n;
}
