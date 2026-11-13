import { WriteResult } from "./types.js";

/**
 * The verbs of a harness where presence in the config means enabled (Cursor, Codex). Such a harness
 * has no disabled state: enable only checks that the entries exist, and disable removes them, the
 * same as remove. Gemini is not one of them: it keeps disabled servers in its `mcp.excluded` list.
 */

/** Enable: every name must already have an entry. Nothing to write. */
export function enablePresent(servers: Record<string, unknown> | undefined, names: string[]): WriteResult {
    const missing = names.filter((name) => !servers?.[name]);

    if (missing.length > 0) {
        throw new Error(`Servers do not exist: ${missing.join(", ")}. Use installServer to add them.`);
    }

    return WriteResult.NoChanges;
}

/** Disable and remove: delete each named entry. True when one was there. */
export function deletePresent(servers: Record<string, unknown> | undefined, names: string[]): boolean {
    let changed = false;

    for (const name of names) {
        if (servers?.[name]) {
            delete servers[name];
            changed = true;
        }
    }

    return changed;
}
