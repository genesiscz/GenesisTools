import type { PageNode } from "@app/chrome-devtools/lib/page-snapshot";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("jev-browser");

const PASSWORD_KEY_RE = /\b(password|passwd|passphrase|heslo)\b/i;

export interface PasswordWall {
    hit: boolean;
    /** The fields that made the wall fire, for the log line and the snapshot evidence. */
    fields: string[];
}

/**
 * A page that asks for a secret the user did not supply stops the run. Jev never invents a
 * password, and a goal loop must not hand a stranger's page an empty credential either, so the
 * surface reports no candidates and the loop ends on `no_candidates`.
 */
export function passwordWall(nodes: PageNode[], inputs: Record<string, string>): PasswordWall {
    const fields = nodes.filter((node) => node.password === true).map((node) => node.name || node.uid);
    if (fields.length === 0) {
        return { hit: false, fields: [] };
    }

    const supplied = Object.keys(inputs).some((key) => PASSWORD_KEY_RE.test(key));
    return { hit: !supplied, fields };
}

/**
 * Whether `next` stays on the origin of `start`. A navigate to another origin is refused, so a
 * link whose text lies about its destination cannot walk the loop off the page it was scoped to.
 */
export function sameOrigin(start: string, next: string): boolean {
    try {
        return new URL(start).origin === new URL(next, start).origin;
    } catch (error) {
        log.debug({ error, start, next }, "same-origin check could not parse a URL; treating it as cross-origin");
        return false;
    }
}
