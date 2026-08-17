/**
 * Genre vocabulary: cleaning, canonicalisation, and the whitelist used to filter
 * Last.fm's tag cloud.
 *
 * MusicBrainz and Last.fm both expose folksonomy tags, not a taxonomy. People tag
 * artists with eras ("2010s"), nationalities ("swedish"), personal collection labels
 * ("seen live", "favourites") and pure noise ("all", "go"). Left alone these dominate
 * any count, so everything passes through `cleanTag` first.
 */

/** Tags that are never a genre, no matter who applied them. */
const DROP_EXACT = new Set([
    "seen live",
    "spotify",
    "favorites",
    "favourite",
    "favourites",
    "beautiful",
    "awesome",
    "cool",
    "good",
    "great",
    "best",
    "love",
    "loved",
    "all",
    "go",
    "art",
    "music",
    "songs",
    "song",
    "track",
    "tracks",
    "album",
    "albums",
    "artist",
    "artists",
    "musician",
    "band",
    "duo",
    "trio",
    "solo",
    "producer",
    "dj",
    "composer",
    "singer",
    "singer-songwriter",
    "vocal",
    "vocalists",
    "male vocalists",
    "female vocalists",
    "male vocalist",
    "female vocalist",
    "remix",
    "remixes",
    "remixer",
    "cover",
    "covers",
    "mashup",
    "bootleg",
    "live",
    "radio",
    "party",
    "summer",
    "night",
    "sad",
    "happy",
    "energetic",
    "epic",
    "melancholy",
    "relax",
    "sexy",
    "fun",
    "banger",
    "bangers",
    "vibe",
    "vibes",
    "mood",
    "playlist",
    "new",
    "old",
    "classic",
    "underrated",
    "unknown",
    "discovered",
    "check out",
    "listen",
    "heard",
    "want to see",
    "my music",
    // Performance descriptors, not genres.
    "instrumental",
    "acoustic",
    "acapella",
    "a cappella",
    "vocals",
    "vocalist",
    "female vocals",
    "male vocals",
    "rapper",
    "piano",
    "guitar",
    "drums",
    "chill",
    "dj tools",
    "dj tool",
    "soundtrack",
    "ost",
    // Labels and scenes that tag like genres but describe who released it or where.
    "monstercat",
    "ncs",
    "nocopyrightsounds",
    "spinnin records",
    "mad decent",
    "london",
    "berlin",
    "bristol",
    "detroit",
    "chicago",
    "new york",
    "los angeles",
]);

/**
 * Eras, countries, nationalities, and "N listeners" style tags.
 *
 * Each entry is a COMPLETE alternative joined with "|". Splitting one alternative across
 * array entries silently produces `…africa)$^(american…`, which can never match, and the
 * only symptom is nationalities quietly reappearing in the results.
 */
const COUNTRIES =
    "usa|uk|us|united states|united kingdom|america|england|scotland|ireland|wales|" +
    "germany|france|sweden|norway|denmark|finland|netherlands|holland|belgium|austria|" +
    "switzerland|italy|spain|portugal|poland|czech|czechia|slovakia|hungary|greece|" +
    "turkey|russia|ukraine|israel|india|japan|korea|china|brazil|mexico|argentina|" +
    "chile|colombia|canada|australia|new zealand|south africa|europe|asia|africa";

const NATIONALITIES =
    "american|british|english|german|french|swedish|dutch|canadian|australian|russian|" +
    "czech|slovak|polish|italian|spanish|norwegian|finnish|danish|belgian|japanese|" +
    "korean|chinese|brazilian|mexican|irish|scottish|ukrainian|austrian|swiss|" +
    "hungarian|greek|turkish|israeli|indian|african|european|latin american";

const DROP_PATTERN = new RegExp(
    ["^(19|20)\\d0s$", "^\\d{2,4}s?$", `^(${COUNTRIES})$`, `^(${NATIONALITIES})$`, "listeners$", "^my ", "^i "].join(
        "|"
    )
);

/** Spelling variants folded into one name so the final counts are not split. */
const CANON: Record<string, string> = {
    "drum n bass": "drum and bass",
    "drum & bass": "drum and bass",
    dnb: "drum and bass",
    "d&b": "drum and bass",
    "drum'n'bass": "drum and bass",
    drumandbass: "drum and bass",
    "liquid funk": "liquid drum and bass",
    "liquid dnb": "liquid drum and bass",
    "jump-up": "jump up",
    "hip-hop": "hip hop",
    hiphop: "hip hop",
    rap: "hip hop",
    "r&b": "rnb",
    "r and b": "rnb",
    "rhythm & blues": "rnb",
    "rhythm and blues": "rnb",
    "contemporary r&b": "rnb",
    "contemporary rnb": "rnb",
    electronica: "electronic",
    "electronic music": "electronic",
    elektronik: "electronic",
    edm: "electronic dance music",
    "dance-pop": "dance pop",
    "synth pop": "synthpop",
    "synth-pop": "synthpop",
    "alt rock": "alternative rock",
    "nu-metal": "nu metal",
    "psy-trance": "psytrance",
    "psy trance": "psytrance",
    "uk garage": "garage",
    "2-step": "2 step",
    "big room": "big room house",
    "riddim dubstep": "riddim",
    "drift-phonk": "drift phonk",
    "phonk music": "phonk",
    "future-bass": "future bass",
    "hard-dance": "hard dance",
};

/**
 * Electronic subgenres MusicBrainz is weak on. The Last.fm whitelist is built from
 * whatever MusicBrainz used across the library plus this seed, so genres that only
 * Last.fm knows about (phonk, hardwave, sigilkore) still survive the filter.
 */
export const SEED_GENRES = [
    "phonk",
    "drift phonk",
    "brazilian phonk",
    "gym phonk",
    "house phonk",
    "hardwave",
    "wave",
    "sigilkore",
    "rage",
    "hyperpop",
    "dark clubbing",
    "jersey club",
    "riddim",
    "colour bass",
    "color bass",
    "melodic bass",
    "future bass",
    "hardstyle",
    "rawstyle",
    "uptempo",
    "frenchcore",
    "hardcore",
    "happy hardcore",
    "hard dance",
    "hands up",
    "hardbass",
    "eurodance",
    "neurofunk",
    "jump up",
    "liquid drum and bass",
    "halftime",
    "breakcore",
    "drumstep",
    "dubstep",
    "brostep",
    "melodic dubstep",
    "trap",
    "hard trap",
    "techno",
    "hard techno",
    "melodic techno",
    "house",
    "tech house",
    "bass house",
    "big room house",
    "progressive house",
    "deep house",
    "future house",
    "electro house",
    "slap house",
    "trance",
    "psytrance",
    "uplifting trance",
    "hard trance",
    "vocal trance",
    "glitch hop",
    "midtempo",
    "downtempo",
    "ambient",
    "synthwave",
    "darksynth",
    "retrowave",
    "chillstep",
    "future garage",
    "garage",
    "2 step",
    "jungle",
    "dub",
    "reggae",
    "dancehall",
    "drill",
    "uk drill",
    "emo rap",
    "cloud rap",
    "metalcore",
    "nu metal",
    "pop punk",
    "indie pop",
    "alt pop",
    "electropop",
    "indie rock",
    "post-hardcore",
    "punk rock",
    "drum and bass",
    "electronic",
    "electronic dance music",
    "dance",
    "pop",
    "rock",
    "hip hop",
    "rnb",
    "soul",
    "funk",
    "disco",
    "metal",
    "country",
    "jazz",
];

/** Normalise one tag; returns null when it is not a genre. */
export function cleanTag(raw: string | undefined | null): string | null {
    let t = (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    t = CANON[t] ?? t;
    if (!t || t.length < 3 || DROP_EXACT.has(t) || DROP_PATTERN.test(t)) {
        return null;
    }

    return t;
}

/** How many Last.fm tags an artist may contribute, in the order the site ranks them. */
export const LASTFM_TOP = 8;

export interface MbArtistRow {
    uri: string;
    name?: string;
    mb?: { exact?: boolean; score?: number; tags?: { name: string; count: number }[] } | null;
}

export interface LfArtistRow {
    uri: string;
    name?: string;
    lf?: { tags?: string[] } | null;
}

/**
 * MusicBrainz tags for one artist row.
 *
 * Only an exact, high-scoring match contributes: MusicBrainz answers a name search with its
 * best guesses, and a 70-point near-match is usually a different band with the same word in
 * its name. Applied by both the enrichment merge and the report-time resolver, so the rule
 * lives here rather than in each of them.
 */
export function musicbrainzTags(row: MbArtistRow): string[] {
    const mb = row.mb;
    if (!mb?.exact || (mb.score ?? 0) < 90) {
        return [];
    }

    const tags: string[] = [];
    for (const t of mb.tags ?? []) {
        const c = cleanTag(t.name);
        if (c && t.count > 0) {
            tags.push(c);
        }
    }

    return tags;
}

/**
 * Last.fm tags for one artist row, filtered through the vocabulary MusicBrainz established.
 *
 * Last.fm matches on artist NAME only, so a collision attaches another act's tag cloud; the
 * whitelist plus the cap is what keeps that from swamping a genre count.
 */
export function lastfmTags(row: LfArtistRow, vocabulary: Set<string>): string[] {
    const tags: string[] = [];
    for (const raw of row.lf?.tags ?? []) {
        const c = cleanTag(raw);
        if (c && vocabulary.has(c) && !tags.includes(c)) {
            tags.push(c);
        }

        if (tags.length >= LASTFM_TOP) {
            break;
        }
    }

    return tags;
}
