import { type HarLog, harEntryPage } from "@genesiscz/utils/hls/har";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";
import type { EventState, ProviderEvent, StreamProvider } from "./types";

/** The webinar player's public API: `GET https://oa-api.streamyard.com/api/public/webinars/<id>`. */
const WEBINAR_API = /^https:\/\/[a-z0-9-]+\.streamyard\.com\/api\/public\/webinars\/([A-Za-z0-9_-]+)$/;

/**
 * Request headers never replayed: HTTP/2 pseudo headers, ones fetch sets itself, and conditional or range headers, which
 * would turn the answer into a 304 or a part of it.
 */
const DROPPED_HEADER =
    /^(:|accept-encoding$|content-length$|host$|connection$|if-none-match$|if-modified-since$|if-match$|if-unmodified-since$|if-range$|range$)/i;

const CHECK_TIMEOUT_MS = 20_000;

const webinarSchema = z.object({
    id: z.string(),
    status: z.string(),
    title: z.string().optional(),
    /** The live HLS master playlist, present while `status` is `live`. */
    watchUrl: z.string().nullish(),
    /** The finished recording as one MP4, present once `status` is `complete` and the file is made. */
    vodUrl: z.string().nullish(),
    isVodEnabled: z.boolean().optional(),
    isVodMediaDeleted: z.boolean().optional(),
});

type Webinar = z.infer<typeof webinarSchema>;

function parseWebinar(text: string | undefined): Webinar | null {
    if (!text) {
        return null;
    }

    try {
        const parsed = webinarSchema.safeParse(SafeJSON.parse(text, { strict: true }));
        return parsed.success ? parsed.data : null;
    } catch (error) {
        logger.debug({ error }, "StreamYard webinar answer is not JSON");
        return null;
    }
}

/** The state an answer describes; shared by the HAR's own answer and a fresh one. */
export function webinarState(webinar: Webinar, headers: Record<string, string>): EventState {
    if (webinar.status === "live" && webinar.watchUrl) {
        return { kind: "live", playlistUrl: webinar.watchUrl, headers };
    }

    if (webinar.status === "complete") {
        if (webinar.isVodEnabled === false) {
            return { kind: "unavailable", reason: "the host turned recordings off" };
        }

        if (webinar.isVodMediaDeleted) {
            return { kind: "unavailable", reason: "the recording was deleted" };
        }

        if (webinar.vodUrl) {
            return { kind: "recorded", url: webinar.vodUrl, headers };
        }

        return { kind: "pending", reason: "it has ended and the recording is still being made" };
    }

    return { kind: "pending", reason: `it is ${webinar.status}` };
}

/** The headers that reach the video CDN: the page's identity, without the API's own credentials. */
function mediaHeaders(headers: Record<string, string>): Record<string, string> {
    const kept: Record<string, string> = {};

    for (const name of ["user-agent", "referer", "origin", "accept-language"]) {
        if (headers[name]) {
            kept[name] = headers[name];
        }
    }

    return kept;
}

export const streamyard: StreamProvider = {
    id: "streamyard",
    name: "StreamYard",

    wantsBody: (url) => WEBINAR_API.test(url),

    find(log: HarLog): ProviderEvent[] {
        const byId = new Map<string, ProviderEvent>();

        for (const entry of log.entries) {
            const match = WEBINAR_API.exec(entry.request.url);

            if (!match || (entry.request.method && entry.request.method !== "GET")) {
                continue;
            }

            const webinar = parseWebinar(entry.response?.content?.text);

            if (!webinar) {
                continue;
            }

            const headers: Record<string, string> = {};

            for (const header of entry.request.headers ?? []) {
                if (!DROPPED_HEADER.test(header.name)) {
                    headers[header.name.toLowerCase()] = header.value;
                }
            }

            byId.set(match[1], {
                provider: "streamyard",
                id: match[1],
                title: webinar.title,
                page: harEntryPage(log, entry),
                capturedStatus: webinar.status,
                capturedAt: entry.startedDateTime,
                request: { url: entry.request.url, headers },
            });
        }

        return [...byId.values()];
    },

    async check(event: ProviderEvent, signal?: AbortSignal): Promise<EventState> {
        const timeout = AbortSignal.timeout(CHECK_TIMEOUT_MS);
        const response = await fetch(event.request.url, {
            headers: event.request.headers,
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });

        if (response.status === 401 || response.status === 403) {
            throw new Error(
                `StreamYard refused the webinar API (HTTP ${response.status}): the player's session in the HAR has expired. Record a fresh one (--chrome-cdp <page url>).`
            );
        }

        if (!response.ok) {
            throw new Error(`StreamYard webinar API answered HTTP ${response.status}`);
        }

        const webinar = parseWebinar(await response.text());

        if (!webinar) {
            throw new Error("StreamYard webinar API answered something that is not a webinar");
        }

        const state = webinarState(webinar, mediaHeaders(event.request.headers));
        logger.debug({ webinar: event.id, status: webinar.status, state: state.kind }, "StreamYard webinar checked");
        return state;
    },
};
