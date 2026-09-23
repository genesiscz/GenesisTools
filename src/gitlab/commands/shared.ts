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

export function positiveInt(value: string | undefined, fallback: number): number {
    const n = Number(value);

    return Number.isInteger(n) && n >= 1 ? n : fallback;
}
