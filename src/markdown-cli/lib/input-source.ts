export type InputSource = "file" | "stdin" | "help";

/**
 * Decides where `markdown-cli` reads its markdown from.
 *
 * A file argument always wins, regardless of stdin's TTY state: stdin is read only when no
 * file was given, or the file is the explicit `-` marker. The old code checked stdin FIRST,
 * so any non-interactive run (an agent, cron, an editor, CI — stdin is `/dev/null`, not a
 * TTY) rendered empty stdin instead of the file the caller actually asked for.
 *
 * This lives outside index.ts so a test can import it without running the CLI —
 * `src/markdown-cli/index.ts` calls `runTool` at module top level.
 */
export function resolveInputSource(file: string | undefined, isStdinTty: boolean): InputSource {
    if (file && file !== "-") {
        return "file";
    }

    if (file === "-" || !isStdinTty) {
        return "stdin";
    }

    return "help";
}
