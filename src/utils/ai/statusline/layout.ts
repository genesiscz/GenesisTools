import { spawnSync } from "node:child_process";
import { env } from "@genesiscz/utils/env";
import { stripAnsi } from "@genesiscz/utils/string";

/** Characters on screen, which is what `wc -m` counted in the shell version. */
export function visibleWidth(text: string): number {
    return Array.from(stripAnsi(text)).length;
}

/**
 * Concatenate parts left to right, skipping any part that would push the line past
 * `maxWidth`. Later parts still get a chance, exactly like the shell `build_line`, so a long
 * branch name drops the branch and keeps the dirty count.
 */
export function buildLine(parts: readonly string[], maxWidth: number): string {
    let result = "";

    for (const part of parts) {
        const candidate = `${result}${part}`;

        if (visibleWidth(candidate) <= maxWidth) {
            result = candidate;
        }
    }

    return result;
}

/**
 * The terminal width the host renders into. The statusline runs with piped stdio, so the
 * columns are read from stderr when it is still the terminal, then `COLUMNS`, then `tput`,
 * then the fallback. `tput` is one spawn and only reached when nothing cheaper answered.
 */
export function terminalWidth(fallback: number): number {
    if (process.stdout.columns) {
        return process.stdout.columns;
    }

    if (process.stderr.columns) {
        return process.stderr.columns;
    }

    const fromEnv = Number.parseInt(env.get("COLUMNS") ?? "", 10);

    if (Number.isFinite(fromEnv) && fromEnv > 0) {
        return fromEnv;
    }

    const tput = spawnSync("tput", ["cols"], { encoding: "utf8" });
    const fromTput = Number.parseInt(tput.stdout?.trim() ?? "", 10);

    return Number.isFinite(fromTput) && fromTput > 0 ? fromTput : fallback;
}
