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
import { SafeJSON } from "@genesiscz/utils/json";
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
export function payload(name: "setupGql" | "harvestLibrary" | "harvestArtists"): string {
    const path = join(import.meta.dir, "..", "..", "page", `${name}.ts`);
    const source = readFileSync(path, "utf8");
    // The files open with a doc comment and then a bare `async (…) => { … }` expression.
    const start = source.search(/async \([^)]*\) =>/);

    if (start < 0) {
        throw new Error(`${path} no longer starts with an \`async (…) =>\` payload`);
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

const CatalogTrackSchema = z.object({
    uri: z.string(),
    name: z.string(),
    playcount: z.number().nullable(),
    albumUri: z.string().nullable(),
    cover: z.string().nullable(),
});

const CatalogReleaseSchema = z.object({
    uri: z.string(),
    name: z.string(),
    type: z.string().nullable(),
    year: z.number().nullable(),
    tracks: z.number().nullable(),
    cover: z.string().nullable(),
});

const ArtistEntrySchema = z.object({
    uri: z.string(),
    name: z.string().nullable(),
    topTracks: z.array(CatalogTrackSchema),
    popularReleases: z.array(CatalogReleaseSchema),
});

/** What `harvestArtists.ts` returns, with each artist left unchecked so one bad entry stays one. */
const ArtistHarvestEnvelopeSchema = z.object({
    requested: z.number(),
    errors: z.array(z.object({ uri: z.string(), error: z.string() })),
    artists: z.array(z.unknown()),
});

export interface ArtistHarvestResult {
    requested: number;
    fetched: number;
    errors: { uri: string; error: string }[];
    artists: z.infer<typeof ArtistEntrySchema>[];
}

/**
 * Checks the payload's result one artist at a time. An entry the page built but got wrong (a track
 * without a name, say) becomes that artist's error, naming the field; every valid artist is kept.
 * Checking the whole array at once turned one bad track into "the harvest returned nothing".
 */
export function parseArtistHarvest(value: unknown): ArtistHarvestResult | null {
    const envelope = parsePayload(ArtistHarvestEnvelopeSchema, value);
    if (!envelope) {
        return null;
    }

    const artists: ArtistHarvestResult["artists"] = [];
    const errors = [...envelope.errors];
    for (const entry of envelope.artists) {
        const parsed = ArtistEntrySchema.safeParse(entry);
        if (parsed.success) {
            artists.push(parsed.data);
            continue;
        }

        const uri =
            typeof entry === "object" && entry !== null && "uri" in entry && typeof entry.uri === "string"
                ? entry.uri
                : "(no uri)";
        const issue = parsed.error.issues[0];
        const what = issue ? `${issue.path.map(String).join(".") || "(entry)"}: ${issue.message}` : "unexpected shape";
        log.warn(
            { uri, issues: parsed.error.issues },
            "artist entry has another shape; reported as that artist's error"
        );
        errors.push({ uri, error: `malformed artist data at ${what}` });
    }

    return { requested: envelope.requested, fetched: artists.length, errors, artists };
}

/**
 * How `harvestArtists.ts` paces itself. The payload gets this object as its second argument, and
 * `artistHarvestBudgetMs` derives the CDP deadline from the same numbers, so the two cannot drift.
 */
export const ARTIST_PACING = {
    /** Least time between two request starts, retries included (about 1 request a second). */
    startIntervalMs: 1_000,
    /** Requests in flight at once: one worker each. */
    concurrency: 3,
    /** Tries per artist: the first request and two retries. */
    attempts: 3,
    /** Deadline of one attempt, body included. */
    attemptMs: 15_000,
    /** Wait before retry n is n times this. */
    backoffMs: 2_000,
} as const;

export type ArtistPacing = { [K in keyof typeof ARTIST_PACING]: number };

/** Room for the evaluation round trip and the page's own work around the requests. */
const ARTIST_BUDGET_MARGIN_MS = 60_000;

/**
 * The longest the artist payload can run, worst case: every attempt of every artist times out.
 *
 * One artist then holds its worker for `attempts` x (a start slot, at most one interval per worker
 * ahead, plus the attempt deadline) plus the back-offs between attempts. Workers take the next
 * artist when free, so the run ends at most one artist's worst time after the others have shared
 * out the rest. A fixed deadline (15 minutes, or 3 s an artist) ran out on stalled runs, threw
 * the whole evaluation away and saved nothing.
 */
export function artistHarvestBudgetMs(artists: number, pacing: ArtistPacing = ARTIST_PACING): number {
    const backoffs = pacing.backoffMs * ((pacing.attempts * (pacing.attempts - 1)) / 2);
    const perArtist = pacing.attempts * (pacing.concurrency * pacing.startIntervalMs + pacing.attemptMs) + backoffs;

    return (Math.ceil(artists / pacing.concurrency) + 1) * perArtist + ARTIST_BUDGET_MARGIN_MS;
}

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
        const tab = await openSignedInGql({ tabs, browserUrl, onLog });

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

/**
 * The artist pages behind Discover: for each URI, its most played songs and popular releases,
 * read through the same signed-in tab and borrowed tokens as `autoHarvest`.
 */
export async function autoHarvestArtists({
    browserUrl,
    onLog,
    driver,
    artistUris,
}: AutoHarvestOptions & { artistUris: string[] }): Promise<ArtistHarvestResult> {
    const tabs = driver ?? createTabDriver(cdpPortOf(browserUrl));

    try {
        const tab = await openSignedInGql({ tabs, browserUrl, onLog });

        onLog(
            `probe ok — reading ${artistUris.length} artist pages ` +
                `(one request every ${ARTIST_PACING.startIntervalMs / 1000} s, at most ${ARTIST_PACING.concurrency} in flight)`
        );

        const args = `${SafeJSON.stringify(artistUris, { strict: true })}, ${SafeJSON.stringify(ARTIST_PACING, { strict: true })}`;
        const source = `async () => (${payload("harvestArtists")})(${args})`;
        const harvested = parseArtistHarvest(
            await tab.evaluate(source, { deadlineMs: artistHarvestBudgetMs(artistUris.length) })
        );

        if (!harvested) {
            throw new Error("the artist harvest returned nothing. Check the Spotify tab is still signed in.");
        }

        log.info(
            { requested: harvested.requested, fetched: harvested.fetched, errors: harvested.errors.length },
            "artist harvest finished"
        );

        return harvested;
    } finally {
        if (!driver) {
            tabs.close();
        }
    }
}

/** Finds or opens the Spotify tab, checks sign-in, borrows the session's tokens and installs `__gql`. */
async function openSignedInGql({
    tabs,
    browserUrl,
    onLog,
}: {
    tabs: TabDriver;
    browserUrl: string;
    onLog: (line: string) => void;
}): Promise<SpotifyTab> {
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

    return tab;
}
