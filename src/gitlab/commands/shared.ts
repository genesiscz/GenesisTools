import { writeFileSync } from "node:fs";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export interface TargetOptions {
    host?: string;
    project?: string;
}

export function withHost(cmd: Command): Command {
    return cmd.option("--host <url>", "GitLab instance (default: $GITLAB_HOST, then glab's default host)");
}

export function withProject(cmd: Command): Command {
    return withHost(cmd).option(
        "--project <path-or-id>",
        "Project as group/name or numeric id (default: $GITLAB_PROJECT, then the origin remote of the current checkout)"
    );
}

/** Progress and diagnostics: stderr, so stdout stays the result. */
export function progress(message: string): void {
    out.printlnErr(message);
}

/** The result to `path` when given, else to stdout. */
export function emit(text: string, path: string | undefined, what: string): void {
    if (path) {
        writeFileSync(path, text);
        progress(`\nWrote ${what} → ${path}`);

        return;
    }

    out.print(text);
}

export function collect(value: string, previous: string[]): string[] {
    return previous.concat([value]);
}

/**
 * A non-negative whole number of days, or an error naming the flag. `Number("abc")` is NaN, and
 * every `age > NaN` comparison is false, so a typo silently produced a sweep with no reviews.
 */
export function wholeDays(value: string, flag: string): number {
    if (!/^\d+$/.test(value.trim())) {
        throw new Error(`${flag} must be a whole number of days (0 or more), got "${value}"`);
    }

    return Number(value.trim());
}

export function positiveInt(value: string | undefined, fallback: number): number {
    const n = Number(value);

    return Number.isInteger(n) && n >= 1 ? n : fallback;
}
