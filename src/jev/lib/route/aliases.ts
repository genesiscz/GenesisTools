/**
 * Utterance aliases for catalogue paths.
 *
 * An alias is a short word a human says instead of the full command path. It is only ever a
 * HINT: the alias note is appended to the row summary so Jev can see it, and a leading alias
 * word raises that row in the deterministic shortlist. An alias never selects a command on its
 * own, because "pr" also appears in sentences that mean something else.
 */
export const ROUTE_ALIASES: Record<string, string> = {
    pr: "github review",
    review: "github review",
    prs: "github pr",
    threads: "github review",
};

export function aliasNote(path: string): string {
    const aliases = Object.entries(ROUTE_ALIASES)
        .filter(([, target]) => path === target || path.startsWith(`${target} `))
        .map(([name]) => name);
    return aliases.length ? ` aliases: ${aliases.join(", ")}` : "";
}

/** Catalogue paths whose alias word appears in the utterance. Used only to rank the shortlist. */
export function aliasedPaths(utterance: string): string[] {
    const words = new Set(utterance.toLowerCase().match(/[a-z0-9-]+/g) ?? []);
    const paths: string[] = [];
    for (const [name, target] of Object.entries(ROUTE_ALIASES)) {
        if (words.has(name) && !paths.includes(target)) {
            paths.push(target);
        }
    }
    return paths;
}
