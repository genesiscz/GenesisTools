/**
 * System locale detection -- requires Node.js (child_process).
 * Separated from date.ts so pure date math stays browser-safe.
 */

import { execSync } from "node:child_process";
import { env } from "@genesiscz/utils/env";

let cachedLocale: string | undefined;

/**
 * A POSIX locale name reduced to the BCP-47 tag `Intl` accepts, or undefined.
 *
 * `LANG=C.UTF-8` is the default on GitHub Actions runners and most containers,
 * and it reduces to "C", which is NOT a language tag: every
 * `new Intl.DateTimeFormat("C")` built from it throws `RangeError: invalid
 * language tag: C`. That took out every date this repo renders under that
 * environment, from `tools ms-teams export` down. "C" and "POSIX" both mean "no
 * localisation", so they are treated as "no preference" and the Intl default
 * answers instead.
 */
export function toLanguageTag(envLocale: string): string | undefined {
    const tag = envLocale.split(".")[0].replace(/_/g, "-");

    if (tag === "C" || tag === "POSIX") {
        return undefined;
    }

    try {
        // A validity probe, not an error path: anything Intl refuses to
        // canonicalise here would throw again inside every formatter below.
        Intl.getCanonicalLocales(tag);
    } catch {
        return undefined;
    }

    return tag;
}

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

    // LC_TIME → LANG → LC_ALL, trimmed, from the one accessor that owns that order.
    const envLocale = env.locale.getPreferred();
    const envTag = envLocale ? toLanguageTag(envLocale) : undefined;

    if (envTag) {
        cachedLocale = envTag;
        return cachedLocale;
    }

    cachedLocale = new Intl.DateTimeFormat().resolvedOptions().locale;
    return cachedLocale;
}
