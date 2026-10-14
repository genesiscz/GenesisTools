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
 *
 * Code passes the surface UUID: cmux renumbers every `surface:N` at a relaunch, so a
 * stored ref can name another tab. A ref is still accepted here because a human may
 * type one on the command line.
 */
export function surfaceTargetArgs(surface: string, workspace?: string): string[] {
    if (!workspace || isSelfIdentifyingSurface(surface)) {
        return ["--surface", surface];
    }

    return ["--workspace", workspace, "--surface", surface];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCmuxUuid(value: string): boolean {
    return UUID_RE.test(value);
}

export function isSelfIdentifyingSurface(surface: string): boolean {
    return isCmuxUuid(surface) || surface.startsWith("surface:") || surface.startsWith("tab:");
}

/**
 * Whether two cmux ids name the same object. cmux prints UUIDs in upper case, while an env
 * var or a hand-typed UUID may be lower case, and cmux accepts either.
 */
/**
 * The one key a cmux UUID is stored under in a map: trimmed and lower case. A map that held upper-case keys from
 * the journal beside lower-case keys from an env var found an entry only by luck of the source (Sonnet F6).
 */
export function cmuxIdKey(id: string): string {
    return id.trim().toLowerCase();
}

export function sameCmuxId(a: string | undefined, b: string | undefined): boolean {
    return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}
