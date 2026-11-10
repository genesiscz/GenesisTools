/**
 * The page side of annotated shots over any CDP session (`CdpLike`): GenesisTools' own `Conn` through `cdpLikeOf`,
 * or a Playwright `CDPSession` in a project that vendors this folder.
 */
import type { CdpLike } from "../cdp-like.ts";
import { callInPage } from "../evaluate.ts";
import { collectTextRects, type DocBox, resolveShotLocators, type WireResolution } from "../in-page/shot-agent.ts";
import type { Locator } from "./locator.ts";

export type { DocBox } from "../in-page/shot-agent.ts";
export type Resolution = WireResolution;

/** The overlay root's id; the text collector skips it. */
export const SHOT_OVERLAY_ID = "genesis-shot-overlay";
/** The attribute `testid=` reads. */
export const TEST_ID_ATTRIBUTE = "data-testid";
const TEXT_RECT_LIMIT = 5000;

/** All locators of a part in one round trip, in order. */
export async function resolveLocators(cdp: CdpLike, locators: readonly Locator[]): Promise<Resolution[]> {
    return callInPage(cdp, resolveShotLocators, { locators: [...locators], testIdAttribute: TEST_ID_ATTRIBUTE });
}

/** The page's text line boxes that touch `clip`: what a label must not cover. */
export async function textRects(cdp: CdpLike, clip: DocBox): Promise<DocBox[]> {
    return callInPage(cdp, collectTextRects, { clip, limit: TEXT_RECT_LIMIT, overlayId: SHOT_OVERLAY_ID });
}

/** A miss in words: `testid=x matched nothing`, with the union member that missed. */
export function describeMiss(resolution: Extract<Resolution, { ok: false }>): string {
    const what = resolution.member ? `${resolution.source} (member ${resolution.member})` : resolution.source;
    return resolution.reason === "none" ? `${what} matched nothing` : `${what} matched only hidden or empty elements`;
}
