import { logger } from "@genesiscz/utils/logger";

/** Before the TUI exists, stopping the wrapper must interrupt its pending native RPC. */
export function createTerminalShutdown(
    server: { close(): Promise<void> },
    getTui: () => { kill(signal: "SIGTERM"): void } | undefined
) {
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= server.close());
    const stopBeforeTui = () => {
        void close().catch((error: unknown) => logger.debug({ error }, "Codex transport shutdown failed"));
    };
    return {
        close,
        terminate() {
            const tui = getTui();
            if (tui) {
                tui.kill("SIGTERM");
            } else {
                stopBeforeTui();
            }
        },
        interrupt() {
            // The terminal delivers interrupts to the running native TUI too.
            if (!getTui()) {
                stopBeforeTui();
            }
        },
    };
}
