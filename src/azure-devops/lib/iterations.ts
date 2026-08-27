/**
 * Iteration (sprint) resolution.
 *
 * Pure logic only: no API calls, no output. The caller fetches the iteration
 * list with `Api.getTeamIterations()` and passes it in.
 *
 * Why not `@CurrentIteration`: that WIQL macro needs a team context and is
 * resolved server-side, so the CLI cannot tell which iteration it picked. We
 * resolve the iteration here and put an explicit `[System.IterationPath]`
 * predicate in the query instead.
 */

import type { TeamIteration } from "@app/azure-devops/api.types";
import { formatLocalDate } from "@genesiscz/utils/date";

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
