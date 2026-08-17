/**
 * Ranking plays by genre.
 *
 * A play counts once per genre it carries, so the shares add up to more than 100%. The
 * denominator every caller must quote is `tagged`: genre coverage is never complete, and a
 * ranked list without it overstates its own authority.
 */
import type { Ctx } from "@app/spotify/lib/context";
import type { Play } from "@app/spotify/lib/history";

export interface GenreRow {
    genre: string;
    plays: number;
    ms: number;
    tracks: Set<string>;
    artists: Set<string>;
}

export interface GenreRanking {
    rows: GenreRow[];
    tagged: number;
    untagged: number;
}

export function genreRows(ctx: Ctx, plays: Play[]): GenreRanking {
    const map = new Map<string, GenreRow>();
    let tagged = 0;
    let untagged = 0;
    for (const p of plays) {
        const gs = ctx.genres.forPlay(p.uri, p.artist);
        if (!gs.length) {
            untagged++;
            continue;
        }

        tagged++;
        for (const g of gs) {
            let r = map.get(g);
            if (!r) {
                r = { genre: g, plays: 0, ms: 0, tracks: new Set(), artists: new Set() };
                map.set(g, r);
            }

            r.plays++;
            r.ms += p.ms;
            r.tracks.add(p.uri);
            r.artists.add(p.artist.toLowerCase());
        }
    }

    return { rows: [...map.values()].sort((a, b) => b.plays - a.plays), tagged, untagged };
}
