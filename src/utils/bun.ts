export interface BunCapabilities {
    /**
     * Bun.WebView is available and headless mode works.
     * Requires Bun >= 1.3.12 (released 2026-04-09).
     */
    headlessBrowser: boolean;

    /** Parsed semver triple from Bun.version. */
    bunVersion: { major: number; minor: number; patch: number };
}

const MIN_MAJOR = 1;
const MIN_MINOR = 3;
const MIN_PATCH = 12;

/**
 * Detect runtime capabilities without throwing.
 * Call once at startup and cache the result.
 */
export function detectBunCapabilities(): BunCapabilities {
    const raw: string = Bun.version;
    const parts = raw.split(".").map(Number);
    const bunVersion = {
        major: parts[0] ?? 0,
        minor: parts[1] ?? 0,
        patch: parts[2] ?? 0,
    };

    const { major, minor, patch } = bunVersion;
    const versionOk =
        major > MIN_MAJOR ||
        (major === MIN_MAJOR && (minor > MIN_MINOR || (minor === MIN_MINOR && patch >= MIN_PATCH)));

    const bunGlobal = Bun as unknown as Record<string, unknown>;
    const headlessBrowser = versionOk && typeof bunGlobal["WebView"] !== "undefined";

    return { headlessBrowser, bunVersion };
}

/**
 * Throw a descriptive Error if Bun.WebView is not available.
 * Includes a `bun upgrade` message in the error text.
 *
 * @throws Error with actionable upgrade instructions when headless browser is unavailable.
 */
export function requireHeadlessBrowser(): void {
    const caps = detectBunCapabilities();

    if (!caps.headlessBrowser) {
        const { major, minor, patch } = caps.bunVersion;
        throw new Error(
            `Bun.WebView requires Bun >= 1.3.12 (current: ${major}.${minor}.${patch}). Run: bun upgrade`,
        );
    }
}
