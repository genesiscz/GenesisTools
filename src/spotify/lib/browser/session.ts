/**
 * Talking to the Spotify tab the user already has open.
 *
 * Everything here attaches to a browser that is ALREADY signed in and reads what the app
 * itself has already done. Nothing mints a token: `open.spotify.com/api/token` is gated
 * behind a rotating TOTP whose secret Spotify deliberately obfuscates and rotates to stop
 * exactly that, and reimplementing it would be working around an anti-automation control
 * rather than using the session the user opened. Reading the headers off a request the page
 * has already sent needs no such thing and breaks nothing when Spotify rotates the secret.
 *
 * Shared by `play run` (which drives the player) and `harvest --auto` (which reads the
 * library), because both need the same thing: find the Spotify tab, keep pointing at it.
 */
import { toolText } from "@genesiscz/utils/devtools/mcp-client";
import { logger } from "@genesiscz/utils/logger";
import type { Client } from "@modelcontextprotocol/client";

const log = logger.child({ component: "spotify:browser" });

export const SPOTIFY_HOST = "open.spotify.com";

/**
 * Cheapest possible "is this tab driveable" probe: the web player installs the React hook,
 * a signed-out marketing page does not. Deliberately not the full fiber walk — this runs
 * once per candidate tab and only needs a yes or no.
 */
export const HAS_PLAYER = `() => ({ ok: !!window.__REACT_DEVTOOLS_GLOBAL_HOOK__ && !!document.querySelector('[data-testid="now-playing-widget"]') })`;

/**
 * Is this page a signed-in web player? Asked of the PAGE, not of the network log.
 *
 * The first version inferred it from traffic — marketing-host calls and no `api-partner` —
 * and told a signed-in user they were signed out, because an idle tab has made no pathfinder
 * request yet while still carrying older marketing calls in its log. The rendered player is
 * the thing that actually distinguishes the two states.
 */
export async function isSignedIn(tab: SpotifyTab): Promise<boolean> {
    return /"ok"\s*:\s*true/.test(await tab.evaluate(HAS_PLAYER));
}
export const SPOTIFY_LIBRARY_URL = "https://open.spotify.com/collection/tracks";

/**
 * chrome-devtools-mcp evaluates against whichever page is SELECTED, and that selection
 * follows the user around the browser. Switching tabs silently redirects every call to a
 * page where nothing we installed exists, which reads exactly like "the player died" — it
 * cost a 175-track run once. So the tab is re-asserted rather than trusted to stay put.
 */
export class SpotifyTab {
    private pageId: number | null = null;

    constructor(private client: Client) {}

    get id(): number | null {
        return this.pageId;
    }

    /** Every open tab on the Spotify host, in the order the browser lists them. */
    private async candidates(): Promise<number[]> {
        const listed = toolText(await this.client.callTool({ name: "list_pages", arguments: {} }));

        return [...listed.matchAll(/^\s*(\d+):\s*(.+)$/gm)]
            .filter((m) => m[2]?.includes(SPOTIFY_HOST))
            .map((m) => Number(m[1]));
    }

    /**
     * The Spotify tab that can actually be driven, not merely the first one by URL.
     *
     * People keep several open, and this tool opens its own when it finds none — so a real
     * browser had three, of which the FIRST was a signed-out leftover from an earlier run.
     * Taking it meant reporting "not signed in" to someone who was signed in two tabs over.
     * Each candidate is probed for the player, and the first that answers wins; if none does,
     * the first candidate is still returned so the caller's navigate-and-retry path runs.
     */
    private async find(): Promise<number | null> {
        const ids = await this.candidates();

        if (ids.length <= 1) {
            return ids[0] ?? null;
        }

        for (const id of ids) {
            try {
                await this.client.callTool({ name: "select_page", arguments: { pageId: id } });
                const probe = toolText(
                    await this.client.callTool({ name: "evaluate_script", arguments: { function: HAS_PLAYER } })
                );

                if (/"ok"\s*:\s*true/.test(probe)) {
                    log.debug({ pageId: id, candidates: ids }, "chose the Spotify tab with a live player");

                    return id;
                }
            } catch (error) {
                log.debug({ error, pageId: id }, "probing a Spotify tab failed; trying the next");
            }
        }

        return ids[0] ?? null;
    }

    /** `rescan` re-lists the tabs, which is what recovers after ids shift under us. */
    async pin({ rescan = false } = {}): Promise<boolean> {
        if (rescan || this.pageId === null) {
            this.pageId = await this.find();
        }

        if (this.pageId === null) {
            return false;
        }

        try {
            await this.client.callTool({ name: "select_page", arguments: { pageId: this.pageId } });

            return true;
        } catch (error) {
            log.debug({ error, pageId: this.pageId }, "select_page failed; will rescan");
            this.pageId = null;

            return false;
        }
    }

    async evaluate(fn: string): Promise<string> {
        return toolText(await this.client.callTool({ name: "evaluate_script", arguments: { function: fn } }));
    }

    async open(url = SPOTIFY_LIBRARY_URL): Promise<void> {
        await this.client.callTool({ name: "navigate_page", arguments: { type: "url", url } });
        await Bun.sleep(4000);
        await this.pin({ rescan: true });
    }
}

export interface PathfinderTokens {
    authorization: string;
    clientToken: string;
}

/**
 * Tells "not signed in" apart from "signed in but the page has not called pathfinder yet".
 *
 * Observed on a real logged-out browser: navigating to the player redirects to the marketing
 * site, which calls `www.spotify.com/api/masthead` and never touches `api-partner`. Both
 * states produce zero pathfinder requests, but only one of them is fixed by waiting, and
 * telling someone to "let the page finish loading" when they are simply logged out sends
 * them in circles.
 */
export function signedOutSignature(networkLog: string): boolean {
    const marketing = /www\.spotify\.com\/api\//.test(networkLog);
    const player = /api-partner\.spotify\.com|spclient\.spotify\.com\/.*\/player/.test(networkLog);

    return marketing && !player;
}

/**
 * The two headers the pathfinder API needs, lifted from a request the page already sent.
 *
 * Hooking `window.fetch` from an evaluated payload does not work: the app captured its own
 * reference long before anything we inject runs. The DevTools network log is the reliable
 * source, and it is the same data the user could read by hand in the Network panel.
 */
export type TokenFailure = "signed-out" | "no-requests";

export async function readPathfinderTokens(client: Client): Promise<PathfinderTokens | { failure: TokenFailure }> {
    const listed = toolText(
        await client.callTool({
            name: "list_network_requests",
            arguments: { resourceTypes: ["fetch", "xhr"], pageSize: 200 },
        })
    );

    // The real format is `reqid=12 POST https://api-partner.spotify.com/pathfinder/v2/query [200]`,
    // one per line under a `## Network requests` heading. An earlier guess at `12: <url>` (the
    // shape `list_pages` uses) could never match, and the symptom was indistinguishable from
    // "the page has not called pathfinder yet".
    const ids = [...listed.matchAll(/^reqid=(\d+)\s+\S+\s+\S*pathfinder\/v\d+\/query/gm)].map((m) => Number(m[1]));
    if (!ids.length) {
        log.debug({ sample: listed.slice(0, 400) }, "no pathfinder request in the network log");

        return { failure: signedOutSignature(listed) ? "signed-out" : "no-requests" };
    }

    // Newest first: an older request may carry a token that has since expired.
    for (const reqid of ids.reverse()) {
        const detail = toolText(await client.callTool({ name: "get_network_request", arguments: { reqid } }));
        // Headers render as `- client-token:VALUE` under `### Request Headers`: a leading
        // dash, and NO space after the colon. Both were wrong in the first version, so even a
        // correctly located request yielded no tokens.
        const authorization = /^[-\s]*authorization:\s*(Bearer\s+\S+)/im.exec(detail)?.[1];
        const clientToken = /^[-\s]*client-token:\s*(\S+)/im.exec(detail)?.[1];

        if (authorization && clientToken) {
            return { authorization: authorization.trim(), clientToken: clientToken.trim() };
        }
    }

    // Pathfinder requests exist but carry no usable headers, which a reload can genuinely fix.
    return { failure: "no-requests" };
}
