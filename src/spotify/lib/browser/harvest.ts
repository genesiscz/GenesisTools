/**
 * `harvest --auto`: the five manual copy-paste steps, done by the tool.
 *
 * The manual path asks a person (or an agent with chrome-devtools-mcp) to read two headers
 * out of the Network panel, paste one payload to install a helper, paste a second payload
 * with a file path, and then run `build`. Every one of those steps is mechanical, and the
 * two involving tokens are the ones where a slip pastes an account credential into a chat
 * log. Doing it here keeps the tokens inside this process.
 *
 * What this does NOT do is mint a token. See `session.ts` for why.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSignedIn, readPathfinderTokens, SpotifyTab } from "@app/spotify/lib/browser/session";
import { parsePayloadResult } from "@app/spotify/lib/play/payloads";
import { withDevtoolsClient } from "@genesiscz/utils/devtools/mcp-client";
import { logger } from "@genesiscz/utils/logger";
import type { Client } from "@modelcontextprotocol/client";

const log = logger.child({ component: "spotify:harvest" });

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

export interface HarvestResult {
    total: number | null;
    fetched: number;
    unique: number;
    requests: number;
    errors: unknown[];
    tracks: Record<string, unknown>[];
}

export interface AutoHarvestOptions {
    browserUrl: string;
    onLog: (line: string) => void;
    /**
     * How to obtain the MCP session. Defaults to spawning chrome-devtools-mcp against
     * `browserUrl`; tests pass a fake, which is the only way the SUCCESS path is reachable
     * without a signed-in Spotify account. Its failure paths were verified against a real
     * logged-out browser; this covers the rest.
     */
    withClient?: <T>(fn: (client: Client) => Promise<T>) => Promise<T>;
}

/**
 * Attaches to the signed-in browser, borrows the tokens the app already used, walks Liked
 * Songs, and returns the harvested rows. The caller writes them, so this stays testable and
 * the file layout lives with the rest of the pipeline.
 */
export async function autoHarvest({ browserUrl, onLog, withClient }: AutoHarvestOptions): Promise<HarvestResult> {
    const connect =
        withClient ??
        (<T>(fn: (client: Client) => Promise<T>) =>
            withDevtoolsClient(fn, { cdpUrl: browserUrl, clientName: "genesis-spotify-harvest" }));

    return connect(async (client) => {
        const tab = new SpotifyTab(client);

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

        let tokens = await readPathfinderTokens(client);

        // An idle tab has issued no pathfinder request since its last navigation, so there is
        // nothing to lift the tokens from. A reload makes the app issue its own — but it does
        // so WHILE loading, so this polls instead of sleeping once: a fixed wait is either
        // too short on a slow load or wasted on a fast one.
        if ("failure" in tokens) {
            onLog("no pathfinder request in this tab's log yet — reloading to make one");
            await tab.open();

            for (let attempt = 0; attempt < 12 && "failure" in tokens; attempt++) {
                await Bun.sleep(2000);
                tokens = await readPathfinderTokens(client);
            }
        }

        if ("failure" in tokens) {
            throw new Error(
                "signed in, but no pathfinder request appeared to read the tokens from.\n" +
                    "  Open https://open.spotify.com/collection/tracks, let it finish loading,\n" +
                    "  then run this again."
            );
        }

        onLog("read the session's own authorization and client-token (kept in this process)");

        const installed = parsePayloadResult<{ installed?: boolean; probeStatus?: number; hint?: string }>(
            await tab.evaluate(preparedSetupGql(tokens))
        );

        if (installed?.probeStatus !== 200) {
            throw new Error(
                `the library probe returned ${installed?.probeStatus ?? "no status"}. ` +
                    (installed?.hint ?? "Reload the Spotify tab and try again.")
            );
        }

        onLog("probe ok — walking Liked Songs (about 4 requests in flight, 800ms between batches)");

        const harvested = parsePayloadResult<HarvestResult>(await tab.evaluate(payload("harvestLibrary")));

        if (!harvested?.tracks?.length) {
            throw new Error("the harvest returned no tracks. Check the Spotify tab is still signed in.");
        }

        log.info(
            { total: harvested.total, unique: harvested.unique, requests: harvested.requests },
            "auto harvest finished"
        );

        return harvested;
    });
}
