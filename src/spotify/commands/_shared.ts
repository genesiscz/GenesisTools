/**
 * The CLI door. Every command here parses flags, calls one `lib/reports/*` function, and
 * then either prints the human rendering or hands the payload to `out.result`. No analysis
 * lives in this directory — the HTTP routes under `ui/routes/api` call the same functions.
 */
import { numberOption } from "@app/spotify/lib/context";
import { PLAY_MS } from "@app/spotify/lib/history";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export interface CommonFlagOptions {
    /**
     * Replaces the `--top` help text. `export` needs this because the shared wording promises
     * the opposite of what it does: there the flag bounds the preview, and `--out` writes
     * every row regardless. Inheriting the analytics wording unchanged made `--top` read as a
     * broken flag, since `--top 1` and `--top 100` printed identical output.
     */
    topDescription?: string;
}

/** Options shared by every analytics command, so `--since` means the same thing everywhere. */
export function common(cmd: Command, { topDescription }: CommonFlagOptions = {}): Command {
    return (
        cmd
            .option("-p, --profile <name>", "which profile to read (default: the configured one)")
            .option("-s, --since <date>", "only plays on or after this local date (YYYY-MM-DD)")
            .option("-u, --until <date>", "only plays on or before this local date (YYYY-MM-DD)")
            .option("-y, --year <year>", "shorthand for a whole calendar year")
            // Says "the table prints" rather than "rows", because --json deliberately returns the
            // WHOLE ranking and records this number as `limit`. A tester asked for 20 forgotten
            // tracks, got 1,401 in JSON with no error, and nearly piped them onward: the flag that
            // reads like a limit has to say where it does and does not limit.
            .option(
                "-n, --top <n>",
                topDescription ?? "how many rows the table prints (--json returns every row, as `limit`)"
            )
            .option("--artist <name>", "restrict to artists whose name contains this")
            .option("--genre <genre>", "restrict to one genre")
            .option("--platform <name>", "restrict to one device (mac, ios, android, web, speaker)")
            .option("--min-ms <ms>", `count a play only above this many ms (default ${PLAY_MS})`)
            .option("--all-plays", "include plays shorter than the 30s threshold")
            .option("--exclude-incognito", "drop private-session plays")
            .option("--tz <zone>", "IANA timezone for day and hour bucketing")
            .option("--json", "machine-readable output")
    );
}

/**
 * `--json` writes the payload to stdout and nothing else; otherwise the human renderer runs.
 * Keeping the branch in one helper is what stops a command from drifting into printing a
 * serialized result through the logger.
 */
export function emit<T>(json: boolean | undefined, payload: T, render: (value: T) => void): void {
    if (json) {
        out.result(payload);

        return;
    }

    render(payload);
}

/**
 * `--top` as a number, with the same default the reports use, and the same validation.
 *
 * It matters most for `compat`, `blend` and `gift`, which never build a normal context: a bare
 * `Number()` turned `--top nope` into NaN and rendered no rows at all, and a negative one made
 * `slice(0, limit)` quietly drop the tail instead of erroring.
 */
export function limitOf(o: { top?: string }, fallback = 20): number {
    return numberOption(o.top, "top", fallback, { min: 0, integer: true });
}

/**
 * Re-word one of `common()`'s options for a command where it means something else.
 *
 * `--top` reads "how many rows to print", which is right for a report and wrong for
 * `play plan new`, where it decides how many tracks get seeded into the plan. A usability
 * test caught exactly that: the tester guessed correctly but said the text pointed the other
 * way, and only running the command confirmed it.
 */
export function describeOption(cmd: Command, flag: string, description: string): Command {
    const option = cmd.options.find((o) => o.long === flag || o.short === flag);
    if (!option) {
        throw new Error(`no option ${flag} on "${cmd.name()}" to describe`);
    }

    option.description = description;

    return cmd;
}
