import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The app bundle id, read from `app.json` so the e2e suite and the build cannot drift apart.
 * Page objects and specs call this instead of repeating the literal, which is how the id came
 * to be written out in sixteen files.
 *
 * `DD_BUNDLE_ID` overrides it when a build is installed under a different identifier.
 */
export function getDevDashboardBundleId(): string {
    const override = process.env.DD_BUNDLE_ID?.trim();

    if (override) {
        return override;
    }

    const configPath = fileURLToPath(new URL("../app.json", import.meta.url));
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
        expo?: { ios?: { bundleIdentifier?: string } };
    };
    const bundleId = config.expo?.ios?.bundleIdentifier;

    if (!bundleId) {
        throw new Error(`app.json has no expo.ios.bundleIdentifier (${configPath}); set DD_BUNDLE_ID to override`);
    }

    return bundleId;
}
