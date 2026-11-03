import { chmodSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { capturePageTraffic, chooseCdpPort } from "@app/chrome-devtools/lib/page-capture";
import { type HarLog, parseHar, readHar } from "@genesiscz/utils/hls/har";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { findProviderEvents, type ProviderEvent, providerWantsBody } from "./providers";

function isPlaylistResponse(url: string, mimeType: string): boolean {
    return /\.m3u8(\?|$)/i.test(url) || mimeType.toLowerCase().includes("mpegurl");
}

export interface BrowserCapture {
    /** The saved HAR, which a later run takes as its input: `tools video stream download <harPath>`. */
    harPath: string;
    log: HarLog;
    /**
     * Player events from earlier captures of the same page. A page swaps its live player for a replay once the
     * broadcast ends, so the platform's recording is reachable only through the event an earlier capture saw.
     */
    earlierEvents: ProviderEvent[];
    port: number;
    portReason: string;
    openedTab: boolean;
    entries: number;
}

/**
 * Records `pageUrl` in the user's own browser over its debug port (the open tab is reloaded, or a new tab is opened
 * and closed again) until the playlists and player API answers stop coming, and saves the HAR, credentials included,
 * readable by the user only.
 */
export async function captureFromBrowser({
    pageUrl,
    port,
    maxSeconds,
}: {
    pageUrl: string;
    port?: number;
    maxSeconds: number;
}): Promise<BrowserCapture> {
    const choice = await chooseCdpPort({ pageUrl, port });
    const wanted = (url: string, mimeType: string) => isPlaylistResponse(url, mimeType) || providerWantsBody(url);
    const result = await capturePageTraffic({
        pageUrl,
        port: choice.port,
        maxSeconds,
        until: wanted,
        wantBody: wanted,
    });

    const dir = toolDataDir("video", "captures");
    mkdirSync(dir, { recursive: true });
    const slug = pageUrl
        .replace(/^https?:\/\//i, "")
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const harPath = join(dir, `${stamp}-${slug}.har`);
    await Bun.write(harPath, SafeJSON.stringify(result.har, { strict: true }));
    chmodSync(harPath, 0o600);
    logger.debug(
        { page: pageUrl, port: choice.port, harPath, entries: result.har.log.entries.length, matches: result.matches },
        "Browser capture saved"
    );

    return {
        harPath,
        log: parseHar(result.har),
        earlierEvents: await earlierCaptureEvents({ dir, slug, except: harPath }),
        port: choice.port,
        portReason: choice.reason,
        openedTab: result.tab.opened,
        entries: result.har.log.entries.length,
    };
}

/** The player events of every earlier capture of the page (`<stamp>-<slug>.har`), the newest answer per event. */
async function earlierCaptureEvents({
    dir,
    slug,
    except,
}: {
    dir: string;
    slug: string;
    except: string;
}): Promise<ProviderEvent[]> {
    const byKey = new Map<string, ProviderEvent>();
    const files = readdirSync(dir)
        .filter((name) => name.endsWith(`-${slug}.har`) && join(dir, name) !== except)
        .sort();

    for (const name of files) {
        try {
            for (const event of findProviderEvents(await readHar(join(dir, name)))) {
                byKey.set(`${event.provider}:${event.id}`, event);
            }
        } catch (error) {
            logger.debug({ error, file: name }, "An earlier capture could not be read");
        }
    }

    return [...byKey.values()];
}
