import { logger } from "@genesiscz/utils/logger";
import { type RouterStatus, routerStatus } from "./status";
import { mintToken, newTokenId, withTokenLock } from "./tokens";

export interface RunLink {
    url: string;
    markdown: string;
}

export function tokenLink(id: string, linkHost: string): string {
    return `https://${linkHost}/t/${id}`;
}

/** A link for a preset works only when the router app is installed, owns https, and routes that preset. */
export function presetEnabled(presetId: string, status: RouterStatus): boolean {
    return (
        status.linkHost !== null &&
        status.installed &&
        status.defaultHandler &&
        status.enabledPresets.includes(presetId)
    );
}

/**
 * One door for clickable links: `path` on the configured link host. Returns null when the link would
 * not work on this Mac, so the caller prints the plain command instead of a dead link.
 */
export function linkFor(
    { presetId, path, label }: { presetId: string; path: string; label: string },
    status: RouterStatus = routerStatus()
): RunLink | null {
    if (!presetEnabled(presetId, status) || status.linkHost === null) {
        return null;
    }

    const url = `https://${status.linkHost}/${path.replace(/^\//, "")}`;
    return { url, markdown: `[${label}](${url})` };
}

/** Mints `target` as a `/t/<id>` link that works `uses` times. The prompt text never enters the link. */
export async function mintLink({
    target,
    uses = 1,
    label,
    linkHost,
}: {
    target: string;
    uses?: number;
    label: string;
    linkHost: string;
}): Promise<RunLink> {
    const id = await withTokenLock(() => mintToken(target, uses));
    const url = tokenLink(id, linkHost);
    return { url, markdown: `[${label}](${url})` };
}

export interface PlannedLink {
    link: RunLink;
    /** Writes the token under the lock. Null when it could not be written: the link must then not be shown. */
    save: () => Promise<RunLink | null>;
}

/**
 * For a synchronous caller (`postHandoff`) that must return the link before it can await: the id is
 * chosen now and the record is written by `save()`. Until `save()` resolves, the link is not live.
 */
export function planMintedLink({
    target,
    uses = 1,
    label,
    linkHost,
}: {
    target: string;
    uses?: number;
    label: string;
    linkHost: string;
}): PlannedLink {
    const id = newTokenId();
    const url = tokenLink(id, linkHost);
    const link = { url, markdown: `[${label}](${url})` };

    return {
        link,
        save: async () => {
            try {
                await withTokenLock(() => mintToken(target, uses, id));
                return link;
            } catch (error) {
                logger.warn({ error }, "browser-router: could not mint a link");
                return null;
            }
        },
    };
}
