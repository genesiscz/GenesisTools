/**
 * Iteration (sprint) resolution.
 *
 * Pure logic only: no API calls, no output. The caller fetches the iteration
 * list with `Api.getTeamIterations()` or `Api.getProjectIterations()` and
 * passes it in.
 *
 * Why not `@CurrentIteration`: that WIQL macro needs a team context and is
 * resolved server-side, so the CLI cannot tell which iteration it picked. We
 * resolve the iteration here and put an explicit `[System.IterationPath]`
 * predicate in the query instead.
 */

import type { IterationClassificationNode, TeamIteration } from "@app/azure-devops/api.types";
import { formatLocalDate } from "@genesiscz/utils/date";

/** Which endpoint produced the iteration list the command is working from. */
export interface IterationSource {
    kind: "team" | "project";
    /** The team name for `kind: "team"`, null for the project-wide list. */
    team: string | null;
    count: number;
}

/** One line naming the source, so a row-count difference is never a silent surprise. */
export function describeIterationSource(source: IterationSource): string {
    if (source.kind === "team") {
        return `team "${source.team}" (${source.count} iterations)`;
    }

    return `project classification nodes (${source.count} iterations)`;
}

/**
 * Convert a classification-node path to the `System.IterationPath` form WIQL needs.
 *
 * Classification nodes carry a structural path with an `Iteration` segment and a
 * leading backslash (`\Widgets\Iteration\Sprint 17`). `System.IterationPath` has
 * neither (`Widgets\Sprint 17`). Strip one leading backslash, then drop the
 * `\Iteration` segment.
 */
export function toIterationPath(nodePath: string): string {
    return nodePath.replace(/^\\/, "").replace(/\\Iteration(\\|$)/, "$1");
}

/**
 * Flatten the iteration classification tree into the shape `getTeamIterations()`
 * returns. Nodes without a start date are structural containers (the project root,
 * a release folder) rather than sprints, so they are dropped.
 */
export function flattenIterationNodes(root: IterationClassificationNode): TeamIteration[] {
    const flat: TeamIteration[] = [];

    const walk = (node: IterationClassificationNode): void => {
        if (node.attributes?.startDate) {
            flat.push({
                id: node.identifier,
                name: node.name,
                path: toIterationPath(node.path),
                attributes: {
                    startDate: node.attributes.startDate,
                    finishDate: node.attributes.finishDate ?? null,
                },
            });
        }

        for (const child of node.children ?? []) {
            walk(child);
        }
    };

    walk(root);
    return flat;
}

export type IterationResolution =
    | { kind: "resolved"; iteration: TeamIteration; matchedBy: "path" | "name" | "substring" | "current" }
    | { kind: "ambiguous"; candidates: TeamIteration[] }
    | { kind: "not-found"; query: string }
    | { kind: "no-current" };

/** Iteration date attributes are ISO timestamps at midnight; compare on the date part only. */
function datePart(value: string | null | undefined): string | null {
    if (!value) {
        return null;
    }
    return value.slice(0, 10);
}

/**
 * True when `now` falls inside the iteration, inclusive on both ends.
 * The finish date is stored as midnight of the last day, so a timestamp
 * comparison would drop the whole final day. Comparing YYYY-MM-DD keeps it.
 */
export function iterationContainsDate(iteration: TeamIteration, now: Date): boolean {
    const start = datePart(iteration.attributes?.startDate);
    const finish = datePart(iteration.attributes?.finishDate);

    if (!start || !finish) {
        return false;
    }

    const today = formatLocalDate(now);
    return start <= today && today <= finish;
}

/** The iteration whose date range contains `now`, or null when none does. */
export function findCurrentIteration(iterations: TeamIteration[], now: Date): TeamIteration | null {
    return iterations.find((it) => iterationContainsDate(it, now)) ?? null;
}

/**
 * Resolve a user-supplied iteration argument.
 *
 * Order: exact IterationPath, then exact name, then case-insensitive substring
 * on name or path. An empty argument (or the literal "current") resolves by
 * date range. A substring matching several iterations is refused, never guessed.
 */
export function resolveIteration(
    iterations: TeamIteration[],
    query: string | undefined,
    now: Date
): IterationResolution {
    const trimmed = query?.trim() ?? "";

    if (trimmed === "" || trimmed.toLowerCase() === "current") {
        const current = findCurrentIteration(iterations, now);

        if (!current) {
            return { kind: "no-current" };
        }

        return { kind: "resolved", iteration: current, matchedBy: "current" };
    }

    const needle = trimmed.toLowerCase();

    const byPath = iterations.find((it) => it.path.toLowerCase() === needle);

    if (byPath) {
        return { kind: "resolved", iteration: byPath, matchedBy: "path" };
    }

    const byName = iterations.find((it) => it.name.toLowerCase() === needle);

    if (byName) {
        return { kind: "resolved", iteration: byName, matchedBy: "name" };
    }

    const candidates = iterations.filter(
        (it) => it.name.toLowerCase().includes(needle) || it.path.toLowerCase().includes(needle)
    );

    if (candidates.length === 1) {
        return { kind: "resolved", iteration: candidates[0], matchedBy: "substring" };
    }

    if (candidates.length > 1) {
        return { kind: "ambiguous", candidates };
    }

    return { kind: "not-found", query: trimmed };
}
