import { logger } from "@genesiscz/utils/logger";
import { escapeJxa, runJxa } from "./jxa";

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

    const script =
        'ObjC.import("AppKit"); const u = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(' +
        `"${escapeJxa(bundleId)}"); u.isNil() ? "none" : ObjC.unwrap(u.path)`;

    try {
        const found = runJxa(script, 5_000);
        return found && found !== "none" ? found : null;
    } catch (error) {
        logger.debug({ error, bundleId }, "launch-services: the app lookup failed");
        return null;
    }
}
