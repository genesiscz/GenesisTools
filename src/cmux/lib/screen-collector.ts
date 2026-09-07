import type { AutosaveSession } from "@app/cmux/lib/autosave";
import { associateCapturedSurface } from "@app/cmux/lib/capture-journal";
import { saveSurfaceScreen } from "@app/cmux/lib/screen-cache";
import { logger } from "@genesiscz/utils/logger";
import { stripAnsi } from "@genesiscz/utils/string";

export async function collectTerminalScreens(input: {
    session: AutosaveSession;
    journalDirectory?: string;
    directory: string;
    readText: (surfaceId: string) => Promise<string>;
    shouldContinue?: () => boolean;
}): Promise<{ saved: number; written: number; unavailable: number; empty: number; stopped: boolean }> {
    const result = { saved: 0, written: 0, unavailable: 0, empty: 0, stopped: false };
    for (const panel of input.session.windows.flatMap((w) => w.tabManager.workspaces.flatMap((ws) => ws.panels))) {
        if (panel.type !== "terminal") {
            continue;
        }

        if (input.shouldContinue?.() === false) {
            result.stopped = true;
            break;
        }

        try {
            if (panel.stableSurfaceId && input.journalDirectory) {
                try {
                    associateCapturedSurface({
                        directory: input.journalDirectory,
                        surfaceId: panel.id,
                        stableSurfaceId: panel.stableSurfaceId,
                    });
                } catch (error) {
                    logger.warn(
                        { error, surfaceId: panel.id },
                        "[cmux-screens] identity association failed; continuing viewport capture"
                    );
                }
            }
            const text = stripAnsi(await input.readText(panel.id))
                .trimEnd()
                .slice(-200_000);
            if (input.shouldContinue?.() === false) {
                result.stopped = true;
                break;
            }

            if (!text) {
                result.empty++;
                continue;
            }

            const written = saveSurfaceScreen({
                directory: input.directory,
                surfaceId: panel.id,
                stableSurfaceId: panel.stableSurfaceId,
                text,
                atMs: Date.now(),
            });
            result.saved++;
            result.written += Number(written);
        } catch (error) {
            result.unavailable++;
            logger.debug(
                { error, surfaceId: panel.id },
                "[cmux-screens] terminal unavailable; no activation attempted"
            );
            if (error instanceof Error && /timed out|ECONNREFUSED|ENOENT/.test(error.message)) {
                result.stopped = true;
                break;
            }
        }
    }

    return result;
}
