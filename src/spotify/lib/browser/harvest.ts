/**
 * `harvest --auto`: the five manual copy-paste steps, done by the tool.
 *
 * The manual path asks a person to read two headers out of the browser's Network panel,
 * paste one payload into the DevTools Console to install a helper, run a second payload and
 * save its result, and then run `build`. Every one of those steps is mechanical, and the two
 * involving tokens are the ones where a slip pastes an account credential into a chat log.
 * Doing it here keeps the tokens inside this process.
 *
 * What this does NOT do is mint a token. See `session.ts` for why.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cdpPortOf } from "@app/chrome-devtools/lib/cdp";
import { createTabDriver, type TabDriver } from "@app/chrome-devtools/lib/tab-driver";
import { isSignedIn, readPathfinderTokens, SPOTIFY_LIBRARY_URL, SpotifyTab } from "@app/spotify/lib/browser/session";
import { parsePayload } from "@app/spotify/lib/play/payloads";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";

const log = logger.child({ component: "spotify:harvest" });

/** An active tab may send a pathfinder query on its own; this is how long it gets before we make one. */
const IDLE_TOKEN_WAIT_MS = 2_500;
/** Loading the library sends pathfinder queries while it draws, well inside this on a normal connection. */
const LOAD_TOKEN_WAIT_MS = 25_000;
/** The library walk paces itself (about 90 s for 4200 tracks), so the default 30 s deadline is far too short. */
const HARVEST_DEADLINE_MS = 10 * 60_000;

/** The browser payloads are shipped as source and evaluated verbatim, never re-typed here. */
export function payload(name: "setupGql" | "harvestLibrary"): string {
    const path = join(import.meta.dir, "..", "..", "page", `${name}.ts`);
    const source = readFileSync(path, "utf8");
    // The files open with a doc comment and then a bare `async () => { … }` expression.
    const start = source.indexOf("async () =>");

    if (start < 0) {
        throw new Error(`${path} no longer starts with an \`async () =>\` payload`);
    }

    return source.slice(start).replace(/;\s*$/, "");
}

/**
 * `setupGql.ts` ships with `<BEARER>` / `<CLIENT_TOKEN>` placeholders for a human to fill in.
 * Substituting them silently is the one step where a rename in that file would install a
 * helper that authenticates as nobody and fails 401 pages later, so this throws instead.
 */
export function preparedSetupGql(tokens: { authorization: string; clientToken: string }): string {
    const source = payload("setupGql");

    if (!source.includes("Bearer <BEARER>") || !source.includes("<CLIENT_TOKEN>")) {
        throw new Error("setupGql.ts no longer carries the <BEARER>/<CLIENT_TOKEN> placeholders this fills in");
    }

    const filled = source
        .replace("Bearer <BEARER>", tokens.authorization)
        .replace("<CLIENT_TOKEN>", tokens.clientToken);

    if (filled.includes("<BEARER>") || filled.includes("<CLIENT_TOKEN>")) {
        throw new Error("a token placeholder survived substitution; refusing to install a half-configured helper");
    }

    return filled;
}

/** What `setupGql.ts` returns once it has installed the helper and probed the library. */
const SetupResultSchema = z.object({
    installed: z.boolean().optional(),
    probeStatus: z.number().optional(),
    hint: z.string().optional(),
});

/** Loose on purpose: the whole object is returned to the caller, which writes it out. */
const HarvestResultSchema = z
    .object({
        total: z.number().nullable(),
        fetched: z.number(),
        unique: z.number(),
        requests: z.number(),
        errors: z.array(z.unknown()),
        tracks: z.array(z.record(z.string(), z.unknown())),
    })
    .passthrough();

export type HarvestResult = z.infer<typeof HarvestResultSchema>;

export interface AutoHarvestOptions {
    browserUrl: string;
    onLog: (line: string) => void;
    /**
     * The browser's tabs. Defaults to a CDP driver on `browserUrl`'s port, closed when the
     * harvest ends; a passed-in driver belongs to the caller. Tests pass a fake, which is the
     * only way the SUCCESS path is reachable without a signed-in Spotify account.
     */
    driver?: TabDriver;
}

/**
 * Attaches to the signed-in browser, borrows the tokens the app already used, walks Liked
 * Songs, and returns the harvested rows. The caller writes them, so this stays testable and
 * the file layout lives with the rest of the pipeline.
 */
export async function autoHarvest({ browserUrl, onLog, driver }: AutoHarvestOptions): Promise<HarvestResult> {
    const tabs = driver ?? createTabDriver(cdpPortOf(browserUrl));

    try {
        const tab = new SpotifyTab(tabs);

        if (!(await tab.pin({ rescan: true }))) {
            onLog("no open.spotify.com tab — opening one");
            await tab.open();
        }

        if (tab.id === null) {
            throw new Error(
                "could not find or open an open.spotify.com tab.\n" +
                    `  Is the browser running with remote debugging on ${browserUrl}?`
            );
        }

        onLog(`tab ${tab.id} (${browserUrl})`);

        // Sign-in is decided on the SETTLED page, before any navigation, and by asking the
        // page rather than sniffing traffic. Both of those were wrong before: the log-based
        // guess called an idle signed-in tab "signed out", and checking after a reload asked
        // a page that had not finished drawing its player yet. Either way a signed-in user
        // was told to go and sign in.
        if (!(await isSignedIn(tab))) {
            throw new Error(
                "that browser is not signed in to Spotify.\n" +
                    "  The web player is not on the page, so there is no library to read.\n" +
                    "  Sign in at https://open.spotify.com, then run this again.\n" +
                    `  (Checked the browser at ${browserUrl} — a different profile may be the signed-in one.)`
            );
        }

        let tokens = await readPathfinderTokens(tab, { timeoutMs: IDLE_TOKEN_WAIT_MS });

        // An idle tab sends no pathfinder request, so there is nothing to lift the tokens from.
        // Loading the library makes the app send its own while it draws. The wait listens before
        // the navigation starts and ends at the first matching request, so neither a slow load
        // nor a fast one is guessed at with a fixed sleep.
        if ("failure" in tokens) {
            onLog("no pathfinder request yet, loading the library to make one");
            tokens = await readPathfinderTokens(tab, {
                timeoutMs: LOAD_TOKEN_WAIT_MS,
                cause: { navigate: SPOTIFY_LIBRARY_URL },
            });
        }

        if ("failure" in tokens) {
            throw new Error(
                "signed in, but no pathfinder request appeared to read the tokens from.\n" +
                    "  Open https://open.spotify.com/collection/tracks, let it finish loading,\n" +
                    "  then run this again."
            );
        }

        onLog("read the session's own authorization and client-token (kept in this process)");

        const installed = parsePayload(SetupResultSchema, await tab.evaluate(preparedSetupGql(tokens)));

        if (installed?.probeStatus !== 200) {
            throw new Error(
                `the library probe returned ${installed?.probeStatus ?? "no status"}. ` +
                    (installed?.hint ?? "Reload the Spotify tab and try again.")
            );
        }

        onLog("probe ok — walking Liked Songs (about 4 requests in flight, 800ms between batches)");

        const harvested = parsePayload(
            HarvestResultSchema,
            await tab.evaluate(payload("harvestLibrary"), { deadlineMs: HARVEST_DEADLINE_MS })
        );

        if (!harvested?.tracks.length) {
            throw new Error("the harvest returned no tracks. Check the Spotify tab is still signed in.");
        }

        log.info(
            { total: harvested.total, unique: harvested.unique, requests: harvested.requests },
            "auto harvest finished"
        );

        return harvested;
    } finally {
        if (!driver) {
            tabs.close();
        }
    }
}
