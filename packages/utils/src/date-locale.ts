/**
 * System locale detection -- requires Node.js (child_process).
 * Separated from date.ts so pure date math stays browser-safe.
 */

import { execSync } from "node:child_process";

let cachedLocale: string | undefined;

/**
 * Detect system locale.
 * macOS: `defaults read NSGlobalDomain AppleLocale` (e.g. "cs_CZ" -> "cs-CZ")
 * Fallback: $LC_TIME / $LANG / $LC_ALL -> Intl default
 */
export function getSystemLocale(): string {
    if (cachedLocale) {
        return cachedLocale;
    }

    if (process.platform === "darwin") {
        try {
            const raw = execSync("defaults read NSGlobalDomain AppleLocale", {
                encoding: "utf-8",
                timeout: 1000,
            }).trim();

            if (raw) {
                const [base, suffix] = raw.split("@");
                let locale = base.replace(/_/g, "-");

                if (suffix) {
                    const rgMatch = suffix.match(/rg=([a-z]{2})/i);

                    if (rgMatch) {
                        const regionCode = rgMatch[1].toUpperCase();
                        const lang = locale.split("-")[0];
                        locale = `${lang}-${regionCode}`;
                    }
                }

                cachedLocale = locale;
                return cachedLocale;
            }
        } catch {
            // fall through
        }
    }

    const envLocale = process.env.LC_TIME || process.env.LANG || process.env.LC_ALL;

    if (envLocale) {
        cachedLocale = envLocale.split(".")[0].replace(/_/g, "-");
        return cachedLocale;
    }

    cachedLocale = new Intl.DateTimeFormat().resolvedOptions().locale;
    return cachedLocale;
}
