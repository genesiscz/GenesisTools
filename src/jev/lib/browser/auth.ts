import { logger } from "@genesiscz/utils/logger";
import { inputValueFor } from "./fields";

const { log } = logger.scoped("jev-browser");

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
export function passwordWall(
    secrets: Array<{ label: string; field: { type: string; name: string; id: string; ariaLabel: string } }>,
    inputs: Record<string, string>
): PasswordWall {
    // Checked field by field with the same match a fill uses: one password key must not unlock a
    // page that also asks for a one-time code or a card number nobody supplied.
    const fields = secrets
        .filter(
            (secret, index) =>
                inputValueFor({
                    node: { name: secret.label },
                    field: { uid: `secret${index + 1}`, ...secret.field },
                    inputs,
                }) === undefined
        )
        .map((secret) => secret.label);
    return { hit: fields.length > 0, fields };
}

/**
 * Whether following `href` from `page` would leave the page's origin. Only http(s) targets navigate
 * away; a `#fragment` or `javascript:` link stays on the page.
 */
export function leavesOrigin(page: string, href: string): boolean {
    try {
        const target = new URL(href, page);
        return (target.protocol === "http:" || target.protocol === "https:") && !sameOrigin(page, target.href);
    } catch (error) {
        log.debug({ error, page, href }, "link target did not parse; treating it as leaving the origin");
        return true;
    }
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
