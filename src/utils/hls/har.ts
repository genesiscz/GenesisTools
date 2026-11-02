import { SafeJSON } from "@genesiscz/utils/json";
import { z } from "zod";
import { isPlaylistText } from "./playlist";

const harSchema = z.object({
    log: z.object({
        pages: z.array(z.object({ id: z.string().optional(), title: z.string().optional() })).optional(),
        entries: z.array(
            z.object({
                pageref: z.string().optional(),
                startedDateTime: z.string().optional(),
                request: z.object({
                    url: z.string(),
                    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
                }),
                response: z
                    .object({
                        status: z.number().optional(),
                        content: z.object({ mimeType: z.string().optional(), text: z.string().optional() }).optional(),
                    })
                    .optional(),
            })
        ),
    }),
});

/** Request headers a CDN may check; every other header the browser sent is dropped. */
const REPLAYED_HEADERS = new Set(["referer", "origin", "user-agent", "cookie", "authorization", "accept-language"]);

export interface HarPlaylist {
    url: string;
    /** "master" lists variants, "media" lists segments; "unknown" when the HAR kept no response body. */
    kind: "master" | "media" | "unknown";
    headers: Record<string, string>;
    /** The page title (often the page URL) of the page that requested it. */
    page?: string;
    startedAt?: string;
}

function isPlaylistUrl(url: string): boolean {
    try {
        return new URL(url).pathname.toLowerCase().endsWith(".m3u8");
    } catch {
        return false;
    }
}

function directoryOf(url: string): string {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.slice(0, parsed.pathname.lastIndexOf("/") + 1)}`;
}

/** Every HLS playlist the HAR requested, one row per URL, in request order. */
export function findHarPlaylists(har: unknown): HarPlaylist[] {
    const parsed = harSchema.safeParse(har);

    if (!parsed.success) {
        throw new Error(`Not a HAR file: ${parsed.error.issues[0]?.message ?? "unknown shape"}`);
    }

    const pageList = parsed.data.log.pages ?? [];
    const pages = new Map(pageList.map((page) => [page.id, page.title]));
    // An iframe's requests carry no pageref; with one page in the HAR, that page played them.
    const onlyPage = pageList.length === 1 ? pageList[0].title : undefined;
    const byUrl = new Map<string, HarPlaylist>();

    for (const entry of parsed.data.log.entries) {
        const { url } = entry.request;
        const mimeType = entry.response?.content?.mimeType?.toLowerCase() ?? "";

        if (!isPlaylistUrl(url) && !mimeType.includes("mpegurl")) {
            continue;
        }

        if (url.startsWith("data:") || url.startsWith("blob:")) {
            continue;
        }

        const text = entry.response?.content?.text;
        const kind =
            !text || !isPlaylistText(text) ? "unknown" : text.includes("#EXT-X-STREAM-INF") ? "master" : "media";
        const known = byUrl.get(url);

        if (known) {
            if (known.kind === "unknown") {
                known.kind = kind;
            }

            continue;
        }

        const headers: Record<string, string> = {};

        for (const header of entry.request.headers ?? []) {
            const name = header.name.toLowerCase();

            if (REPLAYED_HEADERS.has(name)) {
                headers[name] = header.value;
            }
        }

        byUrl.set(url, {
            url,
            kind,
            headers,
            page: (entry.pageref ? pages.get(entry.pageref) : undefined) ?? onlyPage,
            startedAt: entry.startedDateTime,
        });
    }

    return [...byUrl.values()];
}

/**
 * The playlists worth offering as a stream, one per folder: the master when the HAR shows one, else the playlist the
 * player requested first there (a player loads the master before its variants, and a variant plays on its own too).
 */
export function harStreamCandidates(playlists: HarPlaylist[]): HarPlaylist[] {
    const byFolder = new Map<string, HarPlaylist>();

    for (const playlist of playlists) {
        const folder = directoryOf(playlist.url);
        const kept = byFolder.get(folder);

        if (!kept || (playlist.kind === "master" && kept.kind !== "master")) {
            byFolder.set(folder, playlist);
        }
    }

    return [...byFolder.values()];
}

export async function readHarPlaylists(path: string): Promise<HarPlaylist[]> {
    return findHarPlaylists(SafeJSON.parse(await Bun.file(path).text(), { strict: true }));
}
