/**
 * How to name a surface on a cmux command line.
 *
 * `cmux send --workspace <w> --surface <s>` looks the surface up INSIDE `<w>`,
 * and when `<w>` is not the workspace that actually holds `<s>` the lookup lands
 * on something that is not a terminal. The app then answers
 * `invalid_params: Surface is not a terminal`, which reads as "your surface is
 * broken" when the surface is a perfectly good terminal and the WORKSPACE is
 * the wrong one.
 *
 * That is not hypothetical: `CMUX_WORKSPACE_ID` is frozen into a process's
 * environment when it starts, so moving the surface to another workspace (or
 * restoring a session into a new one) leaves every later `send-self` naming a
 * workspace the surface left. Verified 2026-08-28: sending to this very
 * terminal with its own workspace works, and the same surface with a different
 * workspace fails with exactly that error.
 *
 * A UUID or a `surface:N` ref is unique across the whole tree, so the workspace
 * adds nothing and can only be wrong. Only a bare index (`4`) is
 * workspace-relative and still needs the scope.
 */
export function surfaceTargetArgs(surface: string, workspace?: string): string[] {
    if (!workspace || isSelfIdentifyingSurface(surface)) {
        return ["--surface", surface];
    }

    return ["--workspace", workspace, "--surface", surface];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSelfIdentifyingSurface(surface: string): boolean {
    return UUID_RE.test(surface) || surface.startsWith("surface:") || surface.startsWith("tab:");
}
