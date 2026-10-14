import type { WindowEntry } from "@genesiscz/utils/cmux/lib/socket";

/**
 * The UUID of the window a user names, in every spelling they can see: the internal `window:N`
 * ref a saved profile stores, the uuid and the index `cmux list-windows`
 * prints. Only the ref used to match, and `list-windows` never prints it, so
 * the only way to learn a valid `--window` was to save `--scope all` and read
 * the profile JSON. Every cmux call then names the window by this UUID.
 */
export function resolveWindowId(input: string, windows: WindowEntry[]): string {
    const wanted = input.trim();
    const index = /^\d+$/.test(wanted) ? Number(wanted) : undefined;
    const hit = windows.find(
        (window) =>
            window.ref === wanted ||
            window.id.toLowerCase() === wanted.toLowerCase() ||
            (index !== undefined && window.index === index)
    );

    if (hit) {
        return hit.id;
    }

    const known = windows.map((window) => `  ${window.ref}  index ${window.index}  ${window.id}`).join("\n");

    throw new Error(
        `No window matches --window ${input}. Pass a window ref, its index or its uuid (as cmux list-windows prints).` +
            (known ? `\nOpen windows:\n${known}` : "\nNo windows are open.")
    );
}
