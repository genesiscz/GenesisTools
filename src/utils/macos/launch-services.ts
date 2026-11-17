import { logger } from "@genesiscz/utils/logger";
import { escapeJxa, runJxa, runJxaAsync } from "./jxa";

const LOOKUP_TIMEOUT_MS = 5_000;

function lookupScript(bundleId: string): string {
    return (
        'ObjC.import("AppKit"); const u = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(' +
        `"${escapeJxa(bundleId)}"); u.isNil() ? "none" : ObjC.unwrap(u.path)`
    );
}

function foundPath(found: string): string | null {
    return found && found !== "none" ? found : null;
}

/**
 * Where Launch Services finds the app with this bundle id, or null when it knows none. This is the lookup
 * `open -b <id>` and a `<scheme>://` click use, so it answers "would it open" where Spotlight cannot: on
 * 2026-10-23 `mdfind kMDItemCFBundleIdentifier == …` found no app at all on a Mac with indexing on, while both
 * GenesisTools.app and Genesis Markdown.app opened. One osascript start, about 80 ms.
 */
export function appPathForBundleId(bundleId: string): string | null {
    if (process.platform !== "darwin") {
        return null;
    }

    try {
        return foundPath(runJxa(lookupScript(bundleId), LOOKUP_TIMEOUT_MS));
    } catch (error) {
        logger.debug({ error, bundleId }, "launch-services: the app lookup failed");
        return null;
    }
}

/** `appPathForBundleId` without blocking the event loop, for a resident server that answers other requests meanwhile. */
export async function appPathForBundleIdAsync(bundleId: string): Promise<string | null> {
    if (process.platform !== "darwin") {
        return null;
    }

    try {
        return foundPath(await runJxaAsync(lookupScript(bundleId), LOOKUP_TIMEOUT_MS));
    } catch (error) {
        logger.debug({ error, bundleId }, "launch-services: the app lookup failed");
        return null;
    }
}
