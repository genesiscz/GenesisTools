import type { TtydSession } from "./types";

/**
 * Display label for a ttyd session. Pure — lives in its own module (not
 * `manager.ts`) so the browser can import it without dragging the server-only
 * manager (node:child_process, config → auth → node:crypto) into the client
 * bundle.
 */
export function ttydLabel(session: TtydSession): string {
    const name = session.name?.trim();
    if (name) {
        return name;
    }

    return `${session.command.split("/").pop()} :${session.port}`;
}
