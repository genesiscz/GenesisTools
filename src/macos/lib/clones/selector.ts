import { parseVariadic } from "@genesiscz/utils/cli";
import { KEEP_PARTNER_IDS, type KeepPartnerId } from "./keep-partners";
import { parseMinReal } from "./min-real";
import type { ReclaimSelector } from "./reclaim";

export interface SelectorInput {
    /** Positional roots and `--dir` values, already merged by the caller. */
    dirs: string[];
    worktreesOf?: string;
    targets: string[];
    keepPartners: string[];
    /** Raw `--exclude` values; comma lists are split here. */
    exclude: string[];
    /** Raw `--min-real` text, validated here. */
    minReal: string;
}

export type SelectorError =
    | { kind: "no-dirs" }
    | { kind: "unknown-keep-partners"; given: string[] }
    | { kind: "bad-min-real"; given: string };

export type SelectorResult = { selector: ReclaimSelector } | { error: SelectorError };

/** Turn already-resolved flag values into a `ReclaimSelector`, or name what is
 *  wrong with them. Pure: the caller owns prompting, messages and exit codes,
 *  so `reclaim` and `optimize` cannot drift apart on what a selector means. */
export function resolveSelector(input: SelectorInput): SelectorResult {
    if (input.dirs.length === 0) {
        return { error: { kind: "no-dirs" } };
    }

    const unknownPartners = input.keepPartners.filter((k) => !(KEEP_PARTNER_IDS as readonly string[]).includes(k));
    if (unknownPartners.length > 0) {
        return { error: { kind: "unknown-keep-partners", given: unknownPartners } };
    }

    const minReal = parseMinReal(input.minReal);
    if (minReal === null) {
        return { error: { kind: "bad-min-real", given: input.minReal } };
    }

    return {
        selector: {
            dirs: input.dirs,
            ...(input.worktreesOf !== undefined ? { worktreesOf: input.worktreesOf } : {}),
            targets: input.targets,
            exclude: parseVariadic(input.exclude),
            minReal,
            keepPartners: input.keepPartners.filter((k): k is KeepPartnerId =>
                (KEEP_PARTNER_IDS as readonly string[]).includes(k)
            ),
        },
    };
}
