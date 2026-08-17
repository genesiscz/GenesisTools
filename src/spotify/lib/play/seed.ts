/**
 * Turning a question into a track list, so nobody has to hand-write a JSON file of URIs.
 *
 * "Play me the gems I never gave a chance" is the reason this tool has a `play` verb at all,
 * and requiring a hand-built `[{uri, name}]` file to get there put a programming task between
 * the user and their own music. Each source here is a question people actually ask, answered
 * with the same report machinery the CLI already prints.
 */
import { type CommonOpts, type Ctx, context, minMsOf } from "@app/spotify/lib/context";
import { bySong, counted, type Play, sortedAggs } from "@app/spotify/lib/history";
import { globalPlaycounts, loadLibrary } from "@app/spotify/lib/library";
import type { PlayTrack } from "@app/spotify/lib/play/plan";

export const SEED_SOURCES = ["top", "gems", "forgotten", "unplayed", "recent"] as const;
export type SeedSource = (typeof SEED_SOURCES)[number];

export const SEED_HELP: Record<SeedSource, string> = {
    top: "most played songs",
    gems: "played often, barely streamed by anyone else",
    forgotten: "loved once, silent for months",
    unplayed: "liked but never actually played",
    recent: "most recently added to the library",
};

export function parseSeedSource(value: string | undefined): SeedSource {
    const source = (value ?? "top") as SeedSource;
    if (!SEED_SOURCES.includes(source)) {
        throw new Error(`unknown --from "${value}". Pick one of: ${SEED_SOURCES.join(", ")}`);
    }

    return source;
}

/** A song aggregation carries every release URI; the first is enough to play it. */
function trackOf(label: string, sub: string, uri: string): PlayTrack {
    return { uri, name: label, artists: sub };
}

function fromPlays(plays: Play[], limit: number): PlayTrack[] {
    return sortedAggs(bySong(plays))
        .slice(0, limit)
        .map((a) => trackOf(a.label, a.sub, [...a.uris][0]!));
}

/** Songs that stopped: high total plays, nothing recent. */
function fromForgotten(plays: Play[], limit: number, quietMonths: number): PlayTrack[] {
    const cutoff = Date.now() - quietMonths * 30 * 86_400_000;

    return sortedAggs(bySong(plays))
        .filter((a) => a.last < cutoff)
        .slice(0, limit)
        .map((a) => trackOf(a.label, a.sub, [...a.uris][0]!));
}

export interface SeedInput {
    source: SeedSource;
    limit: number;
    /** Report options, so `--year`, `--genre` and `--artist` narrow the seed like any report. */
    options: CommonOpts;
    given?: Ctx;
    /** For `forgotten`: how long silent counts as forgotten. */
    quietMonths?: number;
}

export function seedTracks({ source, limit, options, given, quietMonths = 12 }: SeedInput): PlayTrack[] {
    const ctx = given ?? context(options);
    // Two play sets, because "what did you listen to" and "did you ever start this" are
    // different questions. `plays` clears the 30s bar and drives every ranking. `touched`
    // does not, and is what `unplayed` must ask: a track started twenty times and skipped at
    // five seconds is not one you have never played, and offering it as "never heard" is a
    // lie the user notices the moment it starts and they recognise it.
    const plays = counted(ctx.plays, minMsOf(options));
    const touched = ctx.plays;

    if (source === "top") {
        return fromPlays(plays, limit);
    }

    if (source === "forgotten") {
        return fromForgotten(plays, limit, quietMonths);
    }

    // The remaining sources read the harvested library, which not every profile has.
    // Local files are excluded: a real library contained `spotify:local:::Rihanna+-+Pon+De+
    // Replay...`, which is a legitimate saved track with no playcount and no artists, and
    // which the web player cannot start by URI. Seeding one produces a plan entry that fails
    // at playback for a reason the user cannot act on.
    const library = loadLibrary(ctx.profile).filter((t) => !t.uri.startsWith("spotify:local:"));
    if (!library.length) {
        throw new Error(
            `--from ${source} needs the harvested library, and profile "${ctx.profile.name}" has none.\n` +
                `  tools spotify harvest   # then: tools spotify build --profile ${ctx.profile.name}\n` +
                "  Or seed from listening history instead: --from top | forgotten"
        );
    }

    if (source === "recent") {
        return [...library]
            .sort((a, b) => (b.addedAt ?? "").localeCompare(a.addedAt ?? ""))
            .slice(0, limit)
            .map((t) => trackOf(t.name, t.artists[0]?.name ?? "", t.uri));
    }

    if (source === "unplayed") {
        const everStarted = new Set(touched.map((p) => p.uri));

        return library
            .filter((t) => !everStarted.has(t.uri))
            .slice(0, limit)
            .map((t) => trackOf(t.name, t.artists[0]?.name ?? "", t.uri));
    }

    // gems: played a lot by this person, streamed little by the world.
    const global = globalPlaycounts(ctx.profile);
    const mine = new Map<string, number>();
    for (const p of plays) {
        mine.set(p.uri, (mine.get(p.uri) ?? 0) + 1);
    }

    return library
        .map((t) => ({ t, plays: mine.get(t.uri) ?? 0, count: global.get(t.uri) ?? Number.POSITIVE_INFINITY }))
        .filter((r) => r.plays >= 3 && Number.isFinite(r.count))
        .sort((a, b) => b.plays / Math.max(1, b.count) - a.plays / Math.max(1, a.count))
        .slice(0, limit)
        .map((r) => trackOf(r.t.name, r.t.artists[0]?.name ?? "", r.t.uri));
}
