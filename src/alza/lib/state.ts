import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { type VisitorState, visitorStateSchema } from "./account-schemas";
import type { AlzaCookieJar } from "./api";

/**
 * The visitor identity that has to survive between CLI runs. Live probe 2026-11-01: the anonymous basket is keyed by
 * the `IDOX` cookie (a new process with the same Balancer-Guid saw an empty basket; one with only `IDOX` saw it), so
 * the visitor id alone is not enough and the two long-lived visitor cookies are kept beside it.
 */

const PERSISTED_COOKIES = new Set(["IDOX", "VST"]);

export function statePath(): string {
    return toolDataDir("alza", "state.json");
}

export interface SetCookie {
    name: string;
    value: string;
    /** Max-Age=0 or an expiry in the past: the server deleted the cookie. */
    expired: boolean;
}

/**
 * The impersonated client joins repeated `set-cookie` headers with ", ". Split only before a `name=` that follows a comma, so the
 * comma inside `expires=Sun, 01-Nov-26 …` stays in its cookie.
 */
export function splitSetCookie(header: string, now = Date.now()): SetCookie[] {
    return header
        .split(/,\s*(?=[^=;,\s]+=)/)
        .map((part) => part.trim())
        .filter(Boolean)
        .flatMap((part): SetCookie[] => {
            const [pair = "", ...attributes] = part.split(";").map((piece) => piece.trim());
            const eq = pair.indexOf("=");
            if (eq <= 0) {
                return [];
            }

            let expired = false;
            for (const attribute of attributes) {
                const [key = "", raw = ""] = attribute.split("=", 2);
                const lower = key.trim().toLowerCase();
                if (lower === "max-age" && Number(raw) <= 0) {
                    expired = true;
                }

                if (lower === "expires") {
                    const at = Date.parse(raw.trim());
                    if (Number.isFinite(at) && at <= now) {
                        expired = true;
                    }
                }
            }

            return [{ name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), expired }];
        });
}

export class VisitorSession implements AlzaCookieJar {
    private dirty: boolean;

    private constructor(
        private readonly state: VisitorState,
        private readonly path: string,
        isNew: boolean
    ) {
        this.dirty = isNew;
    }

    /** Reads the saved visitor, or starts a new one in memory. Never writes. */
    static load(path = statePath()): VisitorSession {
        if (existsSync(path)) {
            try {
                const parsed = visitorStateSchema.safeParse(
                    SafeJSON.parse(readFileSync(path, "utf8"), { strict: true })
                );
                if (parsed.success) {
                    return new VisitorSession(parsed.data, path, false);
                }

                logger.warn({ path, issues: parsed.error.issues.slice(0, 3) }, "alza state file has an unknown shape");
            } catch (error) {
                logger.warn({ error, path }, "alza state file is unreadable; starting a new visitor");
            }
        }

        return new VisitorSession({ visitorId: randomUUID(), cookies: {} }, path, true);
    }

    get visitorId(): string {
        return this.state.visitorId;
    }

    header(): string | undefined {
        const pairs = Object.entries(this.state.cookies).map(([name, value]) => `${name}=${value}`);
        return pairs.length > 0 ? pairs.join("; ") : undefined;
    }

    absorb(setCookie: string | undefined): void {
        if (!setCookie) {
            return;
        }

        for (const cookie of splitSetCookie(setCookie)) {
            if (!PERSISTED_COOKIES.has(cookie.name)) {
                continue;
            }

            if (cookie.expired || cookie.value === "") {
                if (cookie.name in this.state.cookies) {
                    delete this.state.cookies[cookie.name];
                    this.dirty = true;
                }

                continue;
            }

            if (this.state.cookies[cookie.name] !== cookie.value) {
                this.state.cookies[cookie.name] = cookie.value;
                this.dirty = true;
            }
        }
    }

    /** Writes the visitor when it is new or a kept cookie changed. Mode 0600: the cookie opens the basket. */
    save(): void {
        if (!this.dirty) {
            return;
        }

        atomicWriteFileSync(this.path, `${SafeJSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
        this.dirty = false;
        logger.debug({ path: this.path, cookies: Object.keys(this.state.cookies) }, "alza visitor state saved");
    }
}
