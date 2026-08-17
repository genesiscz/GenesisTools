/**
 * Getting the data in, and getting it back out.
 *
 * `doctor` only ever READS. When it finds a gap it prints the command that would fix it; it
 * never runs one. Every other verb here mutates on purpose and says so in its name.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type CommonOpts, type Ctx, context, head, minMsOf, type ReportHead } from "@app/spotify/lib/context";
import { byArtist, bySong, byTrack, counted, sortedAggs } from "@app/spotify/lib/history";
import { globalPlaycounts, libraryPath, loadLibrary } from "@app/spotify/lib/library";
import { loadRegistry, type Profile } from "@app/spotify/lib/profiles";

export const EXPORT_KINDS = ["tracks", "songs", "artists", "library"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export interface ExportResult {
    head: ReportHead;
    kind: ExportKind;
    headers: string[];
    objects: Record<string, unknown>[];
    /** The same objects flattened to strings, in `headers` order, ready for CSV. */
    rows: (string | number | boolean)[][];
}

function flatten(headers: string[], objects: Record<string, unknown>[]): (string | number | boolean)[][] {
    return objects.map((r) =>
        headers.map((h) => {
            const v = r[h];
            if (Array.isArray(v)) {
                return v.join("; ");
            }

            if (v === null || v === undefined) {
                return "";
            }

            return v as string | number | boolean;
        })
    );
}

export function exportReport(kind: ExportKind, o: CommonOpts, given?: Ctx): ExportResult {
    const ctx = given ?? context(o);
    const plays = counted(ctx.plays, minMsOf(o));

    // The library and the playcounts are each a file read, and only the track/song exports
    // need them. `library` reads the library once, here, rather than once for the `liked` set
    // and again for the rows.
    if (kind === "library") {
        const lib = loadLibrary(ctx.profile);
        const playsByUri = new Map<string, number>();
        for (const p of plays) {
            playsByUri.set(p.uri, (playsByUri.get(p.uri) ?? 0) + 1);
        }

        const headers = ["uri", "track", "artist", "album", "addedAt", "myPlays", "globalPlaycount", "genres"];
        const objects = lib.map((t) => ({
            uri: t.uri,
            track: t.name,
            artist: t.artists.map((a) => a.name).join(", "),
            album: t.album?.name ?? "",
            addedAt: t.addedAt,
            myPlays: playsByUri.get(t.uri) ?? 0,
            globalPlaycount: t.playcount ?? null,
            genres: t.genres ?? [],
        }));

        return { head: head(ctx), kind, headers, objects, rows: flatten(headers, objects) };
    }

    if (kind === "artists") {
        const headers = [
            "rank",
            "artist",
            "plays",
            "shortPlays",
            "hours",
            "tracks",
            "genres",
            "firstPlayed",
            "lastPlayed",
        ];
        const objects = sortedAggs(byArtist(plays)).map((a, i) => ({
            rank: i + 1,
            artist: a.label,
            plays: a.plays,
            shortPlays: a.shortPlays,
            hours: +(a.ms / 3600000).toFixed(2),
            tracks: a.uris.size,
            genres: ctx.genres.forArtist(a.label),
            firstPlayed: new Date(a.first).toISOString(),
            lastPlayed: new Date(a.last).toISOString(),
        }));

        return { head: head(ctx), kind, headers, objects, rows: flatten(headers, objects) };
    }

    const global = globalPlaycounts(ctx.profile);
    const liked = new Set(loadLibrary(ctx.profile).map((t) => t.uri));
    const aggs = kind === "tracks" ? sortedAggs(byTrack(plays)) : sortedAggs(bySong(plays));
    const headers = [
        "rank",
        "track",
        "artist",
        "plays",
        "shortPlays",
        "hours",
        "releases",
        "liked",
        "globalPlaycount",
        "genres",
        "firstPlayed",
        "lastPlayed",
    ];
    const objects = aggs.map((a, i) => {
        const uris = [...a.uris];
        const uri = uris[0]!;
        // A folded song spans several release URIs, and only some of them may carry a harvested
        // count. Taking the first inserted one made the number depend on play order and read
        // `null` while another release had a figure. The highest is the documented policy: it
        // is the release the world actually listened to.
        const globalPlaycount = uris.reduce<number | null>((best, u) => {
            const count = global.get(u);

            return count === undefined ? best : Math.max(best ?? 0, count);
        }, null);

        return {
            rank: i + 1,
            track: a.label,
            artist: a.sub,
            plays: a.plays,
            shortPlays: a.shortPlays,
            hours: +(a.ms / 3600000).toFixed(2),
            releases: a.uris.size,
            liked: [...a.uris].some((u) => liked.has(u)),
            globalPlaycount,
            genres: ctx.genres.forPlay(uri, a.sub),
            firstPlayed: new Date(a.first).toISOString(),
            lastPlayed: new Date(a.last).toISOString(),
        };
    });

    return { head: head(ctx), kind, headers, objects, rows: flatten(headers, objects) };
}

export function parseExportKind(what: string | undefined): ExportKind {
    const kind = (what ?? "songs") as ExportKind;
    if (!EXPORT_KINDS.includes(kind)) {
        throw new Error(`unknown "${what}". Pick one of: ${EXPORT_KINDS.join(", ")}`);
    }

    return kind;
}

export interface DoctorProfile {
    name: string;
    label: string;
    historyDir: string | null;
    historyOk: boolean;
    dataDir: string | null;
    libraryPath: string | null;
    libraryTracks: number;
    taggedTracks: number;
    hasMusicbrainz: boolean;
    hasLastfm: boolean;
    /** Ordered next commands; empty means this profile is complete. */
    gaps: string[];
}

export interface DoctorReport {
    profiles: DoctorProfile[];
    defaultProfile: string;
}

function diagnose(p: Profile): DoctorProfile {
    const lib = p.dataDir ? loadLibrary(p) : [];
    const path = libraryPath(p);
    const mb = !!p.dataDir && existsSync(join(p.dataDir, "mb_artists.jsonl"));
    const lf = !!p.dataDir && existsSync(join(p.dataDir, "lf_artists.jsonl"));
    const gaps: string[] = [];

    if (!p.historyDir) {
        gaps.push(
            `request the export at spotify.com/account/privacy, then: tools spotify profile add ${p.name} --history <dir>`
        );
    }

    if (!p.dataDir || !path) {
        gaps.push(`no harvested library — run \`tools spotify harvest\` then \`tools spotify build -p ${p.name}\``);
    }

    if (path && !mb) {
        gaps.push(`no MusicBrainz tags — \`tools spotify enrich musicbrainz -p ${p.name}\``);
    }

    if (path && !lf) {
        gaps.push(`no Last.fm tags — \`tools spotify enrich lastfm -p ${p.name}\``);
    }

    return {
        name: p.name,
        label: p.label,
        historyDir: p.historyDir ?? null,
        historyOk: !!p.historyDir && existsSync(p.historyDir),
        dataDir: p.dataDir ?? null,
        libraryPath: path,
        libraryTracks: lib.length,
        taggedTracks: lib.filter((t) => t.genres?.length).length,
        hasMusicbrainz: mb,
        hasLastfm: lf,
        gaps,
    };
}

export function doctorReport(): DoctorReport {
    const reg = loadRegistry();

    return { profiles: reg.profiles.map(diagnose), defaultProfile: reg.defaultProfile };
}
