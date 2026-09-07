import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AutosaveSession, type AutosaveWindow, readAutosaveSession } from "@app/cmux/lib/autosave";
import { captureJournalDirectory } from "@app/cmux/lib/capture-journal";
import { logger } from "@genesiscz/utils/logger";

export function stableSurfaceIdForPanel(surfaceId: string, windows: AutosaveWindow[]): string | undefined {
    const wanted = surfaceId.toLowerCase();
    for (const window of windows) {
        for (const workspace of window.tabManager.workspaces) {
            const panel = workspace.panels.find(
                (panel) => panel.id.toLowerCase() === wanted || panel.stableSurfaceId?.toLowerCase() === wanted
            );
            if (panel?.stableSurfaceId) {
                return panel.stableSurfaceId.toLowerCase();
            }
        }
    }

    return undefined;
}

export function resolveCapturedSurfaceIdentity(input: {
    surfaceId: string;
    session?: AutosaveSession;
    journalDirectory?: string;
}): string | undefined {
    const { surfaceId } = input;
    try {
        const stableId = stableSurfaceIdForPanel(surfaceId, (input.session ?? readAutosaveSession()).windows);
        if (stableId) {
            return stableId;
        }
    } catch (error) {
        logger.debug({ error, surfaceId }, "[cmux-capture] native identity unavailable; checking saved association");
    }

    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(surfaceId)) {
        return undefined;
    }

    const alias = join(input.journalDirectory ?? captureJournalDirectory(), `${surfaceId.toLowerCase()}.identity`);
    if (existsSync(alias)) {
        const stableId = readFileSync(alias, "utf8").trim();
        if (/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(stableId)) {
            return stableId.toLowerCase();
        }
    }

    return undefined;
}
