/**
 * Parse a Commander variadic option value into a flat string array.
 *
 * Handles all common patterns:
 *   --flag "a" "b" "c"        → ["a", "b", "c"]     (Commander gives string[])
 *   --flag a,b,c              → ["a", "b", "c"]     (Commander gives ["a,b,c"])
 *   --flag "a,b,c"            → ["a", "b", "c"]     (Commander gives ["a,b,c"])
 *   --flag "a","b","c"        → ["a", "b", "c"]     (Commander gives ["a,b,c"] or ["a","b","c"])
 *   --flag "a, b , c"         → ["a", "b", "c"]     (trims whitespace)
 *   --flag a                  → ["a"]                (Commander gives "a" or ["a"])
 */
export function parseVariadic(value: unknown): string[] {
    if (typeof value === "string") {
        return value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    }

    if (Array.isArray(value)) {
        return (value as string[]).flatMap((s) =>
            s
                .split(",")
                .map((part) => part.trim())
                .filter(Boolean)
        );
    }

    return [];
}
