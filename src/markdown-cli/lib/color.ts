/**
 * An explicit `--color` / `--no-color` wins; otherwise colour follows the TTY.
 *
 * Commander maps both flags onto the same `color` key and defaults it to true,
 * so the VALUE cannot tell "the user asked for colour" from "nobody said".
 * Only the option's source can, which is why this takes it.
 *
 * This lives outside index.ts so a test can import it without running the CLI —
 * `src/markdown-cli/index.ts` calls `runTool` at module top level.
 */
export function resolveColor(value: boolean | undefined, source: string | undefined, isTty: boolean): boolean {
    if (source === "cli") {
        return value !== false;
    }

    return isTty;
}
