import { logger, setConsoleLevel } from "@app/logger";
import { type RenderOptions, render } from "ink";
import type { ReactNode } from "react";

const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[H";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";

/**
 * Render an Ink tree inside the terminal's alternate screen buffer.
 *
 * Full-screen dashboards must not paint into the primary buffer: Ink frames
 * that reach the viewport height scroll into scrollback, where neither
 * eraseLines nor clearTerminal can reach them — every refresh then leaves a
 * stale duplicate frame behind (and `\x1b[3J` wipes the user's shell
 * scrollback on terminals that honor it). The alternate buffer has no
 * scrollback, so duplicates cannot accumulate, and on exit the user's shell
 * is restored exactly as it was.
 *
 * Falls back to a plain render when stdout is not a TTY.
 */
export async function renderFullScreen(node: ReactNode, options?: RenderOptions): Promise<void> {
    const stdout = options?.stdout ?? process.stdout;

    if (!stdout.isTTY) {
        await render(node, options).waitUntilExit();
        return;
    }

    const leaveAltScreen = (): void => {
        stdout.write(LEAVE_ALT_SCREEN);
    };

    stdout.write(ENTER_ALT_SCREEN);
    // Restore the primary buffer even on hard exits (uncaught throw, signals).
    process.once("exit", leaveAltScreen);

    // Console log lines (pino-pretty on stderr) land on the alternate screen
    // and corrupt Ink's frame — every background log forces a visible flicker.
    // Silence the console threshold while Ink owns the screen; file logging
    // is unaffected and the previous threshold is restored on exit.
    const prevConsoleLevel = logger.level as Parameters<typeof setConsoleLevel>[0];
    setConsoleLevel("silent");

    try {
        await render(node, options).waitUntilExit();
    } finally {
        process.off("exit", leaveAltScreen);
        setConsoleLevel(prevConsoleLevel);
        leaveAltScreen();
    }
}
