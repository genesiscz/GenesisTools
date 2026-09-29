/**
 * Talking to the Spotify tab the user already has open.
 *
 * Everything here attaches to a browser that is ALREADY signed in and reads what the app
 * itself has already done. Nothing mints a token: `open.spotify.com/api/token` is gated
 * behind a rotating TOTP whose secret Spotify deliberately obfuscates and rotates to stop
 * exactly that, and reimplementing it would be working around an anti-automation control
 * rather than using the session the user opened. Reading the headers off a request the page
 * sends needs no such thing and breaks nothing when Spotify rotates the secret.
 *
 * Shared by `play run` (which drives the player) and `harvest --auto` (which reads the
 * library), because both need the same thing: find the Spotify tab and keep driving it. The
 * browser is reached over CDP through a `TabDriver`, which addresses one tab by its target id,
 * so the user switching tabs mid-run does not move our calls to another page.
 */
import {
    type CapturedRequest,
    type RequestWait,
    type RequestWaitOptions,
    type TabDriver,
    TabGoneError,
} from "@app/chrome-devtools/lib/tab-driver";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "spotify:browser" });

export const SPOTIFY_HOST = "open.spotify.com";

/**
 * Cheapest possible "is this tab driveable" probe: the web player installs the React hook,
 * a signed-out marketing page does not. Deliberately not the full fiber walk — this runs
 * once per candidate tab and only needs a yes or no.
 */
export const HAS_PLAYER = `() => ({ ok: !!window.__REACT_DEVTOOLS_GLOBAL_HOOK__ && !!document.querySelector('[data-testid="now-playing-widget"]') })`;

/** How long a freshly loaded tab gets to draw its player: the load event fires before React renders it. */
const PLAYER_RENDER_DEADLINE_MS = 10_000;
const PLAYER_POLL_MS = 500;

/**
 * The secure origin itself, not a substring or the host alone: `open.spotify.com.example.net`, a url
 * carrying the name in its path, and a plain `http:` page (which anything on the network can alter)
 * must never be pinned, since the pinned tab later receives the session's own tokens.
 */
export function isSpotifyUrl(url: string): boolean {
    try {
        return new URL(url).origin === `https://${SPOTIFY_HOST}`;
    } catch (error) {
        log.debug({ error, url }, "tab url did not parse; not a Spotify tab");
        return false;
    }
}

function answersOk(value: unknown): boolean {
    return typeof value === "object" && value !== null && "ok" in value && value.ok === true;
}

/**
 * Is this page a signed-in web player? Asked of the PAGE, not of the network traffic.
 *
 * The first version inferred it from traffic — marketing-host calls and no `api-partner` —
 * and told a signed-in user they were signed out, because an idle tab has made no pathfinder
 * request yet while still carrying older marketing calls in its log. The rendered player is
 * the thing that actually distinguishes the two states.
 */
export async function isSignedIn(tab: SpotifyTab): Promise<boolean> {
    return answersOk(await tab.evaluate(HAS_PLAYER));
}
export const SPOTIFY_LIBRARY_URL = "https://open.spotify.com/collection/tracks";

/**
 * The one Spotify tab a run drives, held by its CDP target id.
 *
 * The id stays valid for the tab's whole life, so nothing has to be re-selected between
 * calls. What can still happen is the tab being closed, or a better candidate existing than
 * the one found first; `pin({ rescan: true })` re-lists the tabs for both.
 */
export class SpotifyTab {
    private tabId: string | null = null;

    constructor(private readonly driver: TabDriver) {}

    get id(): string | null {
        return this.tabId;
    }

    /** Every open tab on the Spotify host, in the order the browser lists them. */
    private async candidates(): Promise<string[]> {
        const tabs = await this.driver.tabs();

        return tabs.filter((tab) => isSpotifyUrl(tab.url)).map((tab) => tab.id);
    }

    private async hasPlayer(tabId: string): Promise<boolean> {
        try {
            return answersOk(await this.driver.evaluate(tabId, HAS_PLAYER));
        } catch (error) {
            log.debug({ error, tabId }, "probing a Spotify tab for its player failed");

            return false;
        }
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
    private async find(): Promise<string | null> {
        const ids = await this.candidates();

        if (ids.length <= 1) {
            return ids[0] ?? null;
        }

        for (const id of ids) {
            if (await this.hasPlayer(id)) {
                log.debug({ tabId: id, candidates: ids }, "chose the Spotify tab with a live player");

                return id;
            }
        }

        return ids[0] ?? null;
    }

    /** `rescan` re-lists the tabs, which is what recovers after the tab was closed. */
    async pin({ rescan = false } = {}): Promise<boolean> {
        if (rescan || this.tabId === null) {
            this.tabId = await this.find();
        }

        return this.tabId !== null;
    }

    /** Evaluates `source` in the pinned tab and returns its value; a page error rejects. */
    async evaluate(source: string, options: { deadlineMs?: number } = {}): Promise<unknown> {
        if (this.tabId === null) {
            throw new Error(`no ${SPOTIFY_HOST} tab to evaluate in`);
        }

        return this.driver.evaluate(this.tabId, source, options);
    }

    /** Waits for the pinned tab to send a matching request; see `TabDriver.waitForRequest`. */
    async waitForRequest(options: RequestWaitOptions): Promise<RequestWait> {
        if (this.tabId === null) {
            throw new Error(`no ${SPOTIFY_HOST} tab to listen to`);
        }

        return this.driver.waitForRequest(this.tabId, options);
    }

    /**
     * Loads `url` in the Spotify tab, or in a NEW tab when there is none. The version built on
     * chrome-devtools-mcp navigated whichever page was selected, which could be the user's own
     * unrelated tab; a tab of our own never takes someone's page away from them.
     */
    async open(url = SPOTIFY_LIBRARY_URL): Promise<void> {
        if (this.tabId !== null) {
            try {
                await this.driver.navigate(this.tabId, url);
                await this.awaitPlayer();

                return;
            } catch (error) {
                if (!(error instanceof TabGoneError)) {
                    throw error;
                }

                log.debug({ tabId: this.tabId }, "the Spotify tab closed before it could be navigated; opening one");
            }
        }

        const opened = await this.driver.open(url);
        this.tabId = opened.id;
        log.info({ tabId: opened.id, url }, "opened a Spotify tab");
        await this.awaitPlayer();
    }

    /** Bounded: a signed-out tab never draws the player, and the caller's own probe reports that. */
    private async awaitPlayer(): Promise<void> {
        const deadline = Date.now() + PLAYER_RENDER_DEADLINE_MS;

        while (this.tabId !== null) {
            if (await this.hasPlayer(this.tabId)) {
                return;
            }

            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                log.debug({ tabId: this.tabId }, "no player drawn before the deadline");

                return;
            }

            await Bun.sleep(Math.min(PLAYER_POLL_MS, remaining));
        }
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

export type TokenFailure = "signed-out" | "no-requests";

/** A pathfinder query carrying both headers; one missing either cannot authenticate the helper. */
export function carriesPathfinderTokens(request: CapturedRequest): boolean {
    return (
        /pathfinder\/v\d+\/query/.test(request.url) &&
        (request.headers.authorization ?? "").startsWith("Bearer ") &&
        Boolean(request.headers["client-token"])
    );
}

export interface ReadTokensOptions {
    timeoutMs: number;
    /** Makes the page send requests once the wait listens; without it only the page's own traffic counts. */
    cause?: RequestWaitOptions["cause"];
}

/**
 * The two headers the pathfinder API needs, lifted from a request the page sends.
 *
 * Hooking `window.fetch` from an evaluated payload does not work: the app captured its own
 * reference long before anything we inject runs. The browser's own network events are the
 * reliable source, and they carry the same data the user could read by hand in the Network
 * panel. Only requests sent during the wait are seen, so an idle tab needs a `cause`.
 */
export async function readPathfinderTokens(
    tab: SpotifyTab,
    { timeoutMs, cause }: ReadTokensOptions
): Promise<PathfinderTokens | { failure: TokenFailure }> {
    const { request, seen } = await tab.waitForRequest({ matches: carriesPathfinderTokens, timeoutMs, cause });
    const authorization = request?.headers.authorization;
    const clientToken = request?.headers["client-token"];

    if (authorization && clientToken) {
        return { authorization: authorization.trim(), clientToken: clientToken.trim() };
    }

    const failure: TokenFailure = signedOutSignature(seen.join("\n")) ? "signed-out" : "no-requests";
    log.debug({ seen: seen.length, failure }, "no pathfinder request carried both tokens");

    return { failure };
}
