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
                    method: z.string().optional(),
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
export type HarLog = z.infer<typeof harSchema>["log"];
export type HarLogEntry = HarLog["entries"][number];

/** The parts of a HAR the stream tools read: pages, and each request with its headers and response body. */
export function parseHar(har: unknown): HarLog {
    const parsed = harSchema.safeParse(har);

    if (!parsed.success) {
        throw new Error(`Not a HAR file: ${parsed.error.issues[0]?.message ?? "unknown shape"}`);
    }

    return parsed.data.log;
}

export async function readHar(path: string): Promise<HarLog> {
    return parseHar(SafeJSON.parse(await Bun.file(path).text(), { strict: true }));
}

/** The page title (often its URL) of the page that made the request; an iframe request in a one-page HAR gets that page. */
export function harEntryPage(log: HarLog, entry: HarLogEntry): string | undefined {
    const pages = log.pages ?? [];
    const page = entry.pageref ? pages.find((candidate) => candidate.id === entry.pageref) : undefined;
    return page?.title ?? (pages.length === 1 ? pages[0].title : undefined);
}

export function findHarPlaylists(har: unknown): HarPlaylist[] {
    return findLogPlaylists(parseHar(har));
}

export function findLogPlaylists(log: HarLog): HarPlaylist[] {
    const byUrl = new Map<string, HarPlaylist>();

    for (const entry of log.entries) {
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
            page: harEntryPage(log, entry),
            startedAt: entry.startedDateTime,
        });
    }

    return [...byUrl.values()];
}

/**
 * The playlists worth offering as a stream, one per folder: the master when the HAR shows one, else the playlist the
 * player requested first there (a player loads the master before its variants, and a variant plays on its own too).
 * A playlist in a subfolder of a master's folder (`<id>/1080p/video.m3u8` under `<id>/playlist.m3u8`) is that master's
 * variant and is not offered on its own.
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

    const masterFolders = [...byFolder.entries()].filter(([, p]) => p.kind === "master").map(([folder]) => folder);
    return [...byFolder.entries()]
        .filter(([folder]) => !masterFolders.some((master) => folder !== master && folder.startsWith(master)))
        .map(([, playlist]) => playlist);
}

export async function readHarPlaylists(path: string): Promise<HarPlaylist[]> {
    return findLogPlaylists(await readHar(path));
}
