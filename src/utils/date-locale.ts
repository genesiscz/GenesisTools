/**
 * System locale detection -- requires Node.js (child_process).
 * Separated from date.ts so pure date math stays browser-safe.
 */

import { execSync } from "node:child_process";

let cachedLocale: string | undefined;

/**
 * @genesiscz/utils must stay free of @app/* imports (boundary guard rule 1), so this
 * can't route through @app/utils/env's trimmed getter — reimplemented locally
 * with the same trim/empty-string semantics.
 */
function getTrimmedEnv(name: string): string | undefined {
    const raw = process.env[name];
    if (raw === undefined) {
        return undefined;
    }

    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

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

    const envLocale = getTrimmedEnv("LC_TIME") ?? getTrimmedEnv("LANG") ?? getTrimmedEnv("LC_ALL");
    const envTag = envLocale ? toLanguageTag(envLocale) : undefined;

    if (envTag) {
        cachedLocale = envTag;
        return cachedLocale;
    }

    cachedLocale = new Intl.DateTimeFormat().resolvedOptions().locale;
    return cachedLocale;
}
