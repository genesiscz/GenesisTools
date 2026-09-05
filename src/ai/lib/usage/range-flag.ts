import { parseTimeRange, type TimeRange } from "@genesiscz/utils/ink/usage-dashboard/types";

/**
 * `--range` is an ENUMERATED flag, so every usage door declares it `[value]` and
 * resolves it here (repo CLAUDE.md, "Enumerated flags"). Declared `<window>`,
 * commander answered a bare `--range` with a generic "argument missing" that
 * never named `60m`, `6h`, `24h` or `7d`.
 *
 * `given` carries the rejected text so the help line can quote it back instead
 * of claiming a value was missing when one was typed (gap/cli).
 */
export type RangeFlag =
    | { status: "unset" }
    | { status: "ok"; range: TimeRange }
    | { status: "invalid"; given?: string };

export function resolveRangeFlag(raw: string | boolean | undefined): RangeFlag {
    if (raw === undefined || raw === false) {
        return { status: "unset" };
    }

    if (raw === true || raw.trim() === "") {
        return { status: "invalid" };
    }

    const range = parseTimeRange(raw.trim());

    if (range === null) {
        return { status: "invalid", given: raw };
    }

    return { status: "ok", range };
}
