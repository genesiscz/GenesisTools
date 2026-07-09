/** Parses a CLI flag value as a non-negative integer, rejecting anything else with a clear error. */
export function parseNonNegativeInt(value: string, flag: string): number {
    if (!/^\d+$/.test(value)) {
        throw new Error(`${flag} must be a non-negative integer, got "${value}"`);
    }

    return Number.parseInt(value, 10);
}
