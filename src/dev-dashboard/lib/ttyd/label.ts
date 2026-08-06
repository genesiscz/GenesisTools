import { deriveTtydDisplayName, type TtydNameSource } from "@app/dev-dashboard/lib/ttyd/naming";

/**
 * Display label for a ttyd session. Pure — lives in its own module (not
 * `manager.ts`) so the browser can import it without dragging the server-only
 * manager (node:child_process, config → auth → node:crypto) into the client
 * bundle.
 *
 * Delegates to {@link deriveTtydDisplayName} so tab chrome and Session Hub share
 * the same identity (tmux session name), not `zsh :port`.
 */
export function ttydLabel(session: TtydNameSource): string {
    return deriveTtydDisplayName(session);
}
