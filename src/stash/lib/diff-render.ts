import { renderUnifiedDiff } from "@app/utils/diff";

export interface RenderDiffArgs {
    before: string;
    after: string;
    label: string;
}

/**
 * Render a unified diff between two text blocks. Stash-tool wrapper over
 * `@app/utils/diff`'s renderUnifiedDiff — used by unapply / update walks to show per-region
 * before-vs-after, and by `tools stash diff` for the per-region inventory.
 *
 * v1.1: switched from shell-out (`spawnSync("diff", ...)` + temp files) to the pure-JS
 * jsdiff-backed implementation. Public API unchanged — callers don't need to update.
 */
export function renderDiff(args: RenderDiffArgs): string {
    return renderUnifiedDiff({ before: args.before, after: args.after, label: args.label });
}
