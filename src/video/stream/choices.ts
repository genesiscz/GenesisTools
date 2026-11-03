import { basename, dirname } from "node:path";
import { formatDuration } from "@genesiscz/utils/format";
import { findLogPlaylists, type HarLog, type HarPlaylist, harStreamCandidates } from "@genesiscz/utils/hls/har";
import { logger } from "@genesiscz/utils/logger";
import { type EventState, findProviderEvents, type ProviderEvent, providerById } from "./providers";
import { describeEvent } from "./recording";
import { chooseVariant, fetchPlaylist, headersFor, type StreamSource, safeUrl, withDefaultHeaders } from "./source";

/** One thing the HAR lets the tool download. `id` is stable across runs, for `--stream` and a printed resume command. */
export type SourceChoice =
    /** The platform's own finished file of a broadcast. */
    | {
          kind: "recording";
          id: string;
          label: string;
          event: ProviderEvent;
          url: string;
          headers: Record<string, string>;
      }
    /** An HLS stream: a live broadcast, or a finished one such as the replay a page shows. */
    | {
          kind: "stream";
          id: string;
          label: string;
          source: StreamSource;
          /** True with EXT-X-ENDLIST, false while live, null when the playlist could not be read. */
          ended: boolean | null;
          durationSec: number | null;
          height: number | null;
          /** Why the playlist could not be read (HTTP 404 once a live stream is over). */
          error?: string;
      }
    /** A platform recording that is not made yet: it can be waited for. */
    | { kind: "pending"; id: string; label: string; event: ProviderEvent; reason: string };

/** The playlist's folder: `.../71cfefd1-6909/playlist.m3u8` gives `71cfefd1-6909`. */
function streamId(playlistUrl: string): string {
    try {
        return basename(dirname(new URL(playlistUrl).pathname)) || "stream";
    } catch {
        return "stream";
    }
}

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

/** Reads a stream's playlists (never its segments): its best height, whether it ended, and its length when it did. */
async function inspectStream(
    source: StreamSource,
    signal?: AbortSignal
): Promise<Pick<Extract<SourceChoice, { kind: "stream" }>, "ended" | "durationSec" | "height" | "error">> {
    try {
        const first = await fetchPlaylist({ url: source.playlistUrl, headers: source.headers, signal });
        let height: number | null = null;
        let media = first;

        if (first.kind === "master") {
            if (first.variants.length === 0) {
                return { ended: null, durationSec: null, height: null, error: "the master playlist lists no variant" };
            }

            const variant = chooseVariant(first.variants, "best");
            height = variant.height ?? null;
            media = await fetchPlaylist({ url: variant.uri, headers: headersFor(variant.uri, source), signal });
        }

        if (media.kind !== "media") {
            return { ended: null, durationSec: null, height, error: "a variant is another master playlist" };
        }

        const durationSec = media.segments.reduce((sum, segment) => sum + segment.durationSec, 0);
        return { ended: media.ended, durationSec: media.ended ? durationSec : null, height };
    } catch (error) {
        logger.debug({ error, playlist: safeUrl(source.playlistUrl) }, "Stream playlist could not be read");
        return {
            ended: null,
            durationSec: null,
            height: null,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function streamLabel(choice: Omit<Extract<SourceChoice, { kind: "stream" }>, "label" | "id">, origin: string): string {
    const where = `${origin} stream from ${hostOf(choice.source.playlistUrl)}`;

    if (choice.error) {
        return `${where}: not readable (${choice.error})`;
    }

    const height = choice.height ? `, ${choice.height}p` : "";

    if (choice.ended) {
        const length = choice.durationSec ? `, ${formatDuration(choice.durationSec, "s")}` : "";
        return `${where}: finished${length}${height} (a replay, or a broadcast that has ended)`;
    }

    return `${where}: live${height} (the CDN keeps only the latest part of a live stream)`;
}

/** Recordings first, then finished streams (longest first), then live ones, then waits, then unreadable streams. */
function rank(choice: SourceChoice): number {
    if (choice.kind === "recording") {
        return 0;
    }

    if (choice.kind === "pending") {
        return 3;
    }

    if (choice.error) {
        return 4;
    }

    return choice.ended ? 1 : 2;
}

/**
 * Everything the HAR lets the tool download, each checked now: each player event's platform recording (or its live
 * stream, or a recording to wait for), and each HLS stream the page loaded, the page's own replay included.
 */
export async function gatherChoices({
    log,
    earlierEvents = [],
    extraHeaders,
    signal,
}: {
    log: HarLog;
    /** Events seen before (earlier captures of the page); the HAR's own answer wins for the same event. */
    earlierEvents?: ProviderEvent[];
    extraHeaders: Record<string, string>;
    signal?: AbortSignal;
}): Promise<{ choices: SourceChoice[]; events: ProviderEvent[] }> {
    const own = findProviderEvents(log);
    const ownKeys = new Set(own.map((event) => `${event.provider}:${event.id}`));
    const events = [...earlierEvents.filter((event) => !ownKeys.has(`${event.provider}:${event.id}`)), ...own];
    const choices: SourceChoice[] = [];
    const seenPlaylists = new Set<string>();
    const usedIds = new Set<string>();
    const uniqueId = (base: string) => {
        let id = base;

        for (let n = 2; usedIds.has(id); n++) {
            id = `${base}-${n}`;
        }

        usedIds.add(id);
        return id;
    };
    const streamChoice = async (source: StreamSource, origin: string) => {
        const facts = await inspectStream(source, signal);
        const choice = { kind: "stream" as const, source, ...facts };
        choices.push({ ...choice, id: uniqueId(streamId(source.playlistUrl)), label: streamLabel(choice, origin) });
    };

    for (const event of events) {
        let state: EventState;

        try {
            state = await providerById(event.provider).check(event, signal);
        } catch (error) {
            logger.warn({ error, event: event.id }, "Player event check failed");
            continue;
        }

        const name = describeEvent(event);

        if (state.kind === "recorded") {
            choices.push({
                kind: "recording",
                id: uniqueId(`recording-${event.id}`),
                label: `${name}: the platform's original recording, one file`,
                event,
                url: state.url,
                headers: state.headers,
            });
        } else if (state.kind === "live") {
            seenPlaylists.add(new URL(state.playlistUrl).pathname);
            await streamChoice(
                { playlistUrl: state.playlistUrl, headers: withDefaultHeaders(state.headers), page: event.page },
                name
            );
        } else if (state.kind === "pending") {
            choices.push({
                kind: "pending",
                id: uniqueId(`recording-${event.id}`),
                label: `${name}: no recording yet (${state.reason}); wait for it`,
                event,
                reason: state.reason,
            });
        }
    }

    for (const candidate of harStreamCandidates(findLogPlaylists(log))) {
        if (seenPlaylists.has(new URL(candidate.url).pathname)) {
            continue;
        }

        await streamChoice(sourceOf(candidate, extraHeaders), "The page's");
    }

    return { choices: choices.sort((a, b) => rankOrder(a, b)), events };
}

function rankOrder(a: SourceChoice, b: SourceChoice): number {
    const byRank = rank(a) - rank(b);

    if (byRank !== 0) {
        return byRank;
    }

    const length = (choice: SourceChoice) => (choice.kind === "stream" ? (choice.durationSec ?? 0) : 0);
    return length(b) - length(a);
}

function sourceOf(candidate: HarPlaylist, extraHeaders: Record<string, string>): StreamSource {
    return {
        playlistUrl: candidate.url,
        headers: withDefaultHeaders({ ...candidate.headers, ...extraHeaders }),
        page: candidate.page,
    };
}

/** `--stream`: a number from the list, a choice id, or a part of a playlist URL. */
export function pickChoice(choices: SourceChoice[], wanted: string): SourceChoice | undefined {
    if (/^\d+$/.test(wanted)) {
        return choices[Number(wanted) - 1];
    }

    return (
        choices.find((choice) => choice.id === wanted) ??
        choices.find((choice) => choice.kind === "stream" && choice.source.playlistUrl.includes(wanted))
    );
}

export function describeChoices(choices: SourceChoice[]): string[] {
    return choices.map((choice, index) => `${index + 1}. ${choice.label}  [--stream ${choice.id}]`);
}
