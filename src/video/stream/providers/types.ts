import type { HarLog } from "@genesiscz/utils/hls/har";

/**
 * One broadcast a player API told the page about: a webinar, an event, a live show. It holds the API request the
 * player made, so the tool can ask the same API again later, after the broadcast has ended.
 */
export interface ProviderEvent {
    /** The provider's `id` in `STREAM_PROVIDERS`. */
    provider: string;
    id: string;
    title?: string;
    /** The page that embedded the player. */
    page?: string;
    /** The status the API answered when the HAR was recorded, such as `live` or `complete`. */
    capturedStatus: string;
    capturedAt?: string;
    request: { url: string; headers: Record<string, string> };
}

/** What a provider says about an event now. */
export type EventState =
    /** On air: an HLS playlist the stream downloader follows to its end. */
    | { kind: "live"; playlistUrl: string; headers: Record<string, string> }
    /** Finished, with the provider's own full-length file. */
    | { kind: "recorded"; url: string; headers: Record<string, string> }
    /** Not there yet: not started, or ended with the recording still being made. Worth asking again. */
    | { kind: "pending"; reason: string }
    /** No recording will come: recordings are off, or it was deleted. */
    | { kind: "unavailable"; reason: string };

/**
 * A video platform whose player asks an API about the broadcast. Adding a platform is one file that implements this
 * and one entry in `STREAM_PROVIDERS`; the HAR reader, the browser capture and the downloader stay as they are.
 */
export interface StreamProvider {
    id: string;
    /** The platform's name, for messages. */
    name: string;
    /** Whether a browser capture must keep this response's body: the player API answers `find` reads. */
    wantsBody(url: string): boolean;
    /** Every event of this platform the HAR's player API answers mention, newest answer per event. */
    find(log: HarLog): ProviderEvent[];
    /** Asks the platform about the event now, with the headers the player sent. */
    check(event: ProviderEvent, signal?: AbortSignal): Promise<EventState>;
}
