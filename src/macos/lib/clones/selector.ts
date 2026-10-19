import { parseVariadic } from "@genesiscz/utils/cli";
import { KEEP_PARTNER_IDS, type KeepPartnerId } from "./keep-partners";
import { type MinRealFlags, resolveMinReal } from "./min-real";
import { DEFAULT_MIN_REAL, type ReclaimSelector } from "./reclaim";

export interface SelectorInput {
    /** Positional roots and `--dir` values, already merged by the caller. */
    dirs: string[];
    worktreesOf?: string;
    targets: string[];
    keepPartners: string[];
    /** Raw `--exclude` values; comma lists are split here. */
    exclude: string[];
    /** Raw `--min-real` and its unit-named aliases, validated here. */
    minReal: MinRealFlags;
}

export type SelectorError =
    | { kind: "no-dirs" }
    | { kind: "unknown-keep-partners"; given: string[] }
    | { kind: "bad-min-real"; message: string };

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

    const minReal = resolveMinReal(input.minReal, DEFAULT_MIN_REAL);
    if ("error" in minReal) {
        return { error: { kind: "bad-min-real", message: minReal.error } };
    }

    return {
        selector: {
            dirs: input.dirs,
            ...(input.worktreesOf !== undefined ? { worktreesOf: input.worktreesOf } : {}),
            targets: input.targets,
            exclude: parseVariadic(input.exclude),
            minReal: minReal.bytes ?? DEFAULT_MIN_REAL,
            keepPartners: input.keepPartners.filter((k): k is KeepPartnerId =>
                (KEEP_PARTNER_IDS as readonly string[]).includes(k)
            ),
        },
    };
}
