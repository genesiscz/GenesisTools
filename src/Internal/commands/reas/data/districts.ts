export interface DistrictInfo {
    /** Display name */
    name: string;
    /** REAS catalog API districtId (maps to Czech "okres") */
    reasId: number;
    /** Sreality API numeric ID */
    srealityId: number;
    /**
     * Which Sreality parameter the srealityId maps to:
     * - "district" → locality_district_id (default, used for most okresy)
     * - "region"   → locality_region_id   (used for Praha = Hlavní město Praha region)
     */
    srealityLocality: "district" | "region";
}

export interface PrahaDistrictInfo extends DistrictInfo {
    /** Praha ward number (1-22) */
    wardNumber: number;
    /** Sreality quarter ID (used with locality_quarter_id parameter) */
    srealityQuarterId: number;
}

// ---------------------------------------------------------------------------
// Major Czech cities / okresy
// ---------------------------------------------------------------------------
// Source: REAS count API probing + Sreality suggest API + estates API verification
// REAS IDs follow Czech "okres" (administrative district) numbering:
//   31xx = Praha, 32xx = Středočeský, 33xx = Jihočeský, 34xx = Plzeňský/Karlovarský,
//   35xx = Ústecký/Liberecký, 36xx = Královéhradecký/Pardubický/Vysočina,
//   37xx = Jihomoravský/Zlínský, 38xx = Olomoucký/Moravskoslezský
// ---------------------------------------------------------------------------

export const DISTRICTS: Record<string, DistrictInfo> = {
    // --- Praha (region-level, not okres) ---
    Praha: { name: "Praha", reasId: 3100, srealityId: 10, srealityLocality: "region" },

    // --- Středočeský kraj (32xx) ---
    Benešov: { name: "Benešov", reasId: 3201, srealityId: 48, srealityLocality: "district" },
    Beroun: { name: "Beroun", reasId: 3202, srealityId: 49, srealityLocality: "district" },
    Kladno: { name: "Kladno", reasId: 3203, srealityId: 50, srealityLocality: "district" },
    Kolín: { name: "Kolín", reasId: 3204, srealityId: 51, srealityLocality: "district" },
    "Kutná Hora": { name: "Kutná Hora", reasId: 3205, srealityId: 52, srealityLocality: "district" },
    Mělník: { name: "Mělník", reasId: 3206, srealityId: 54, srealityLocality: "district" },
    "Mladá Boleslav": { name: "Mladá Boleslav", reasId: 3207, srealityId: 53, srealityLocality: "district" },
    Nymburk: { name: "Nymburk", reasId: 3208, srealityId: 55, srealityLocality: "district" },
    "Praha-východ": { name: "Praha-východ", reasId: 3209, srealityId: 56, srealityLocality: "district" },
    "Praha-západ": { name: "Praha-západ", reasId: 3210, srealityId: 57, srealityLocality: "district" },
    Příbram: { name: "Příbram", reasId: 3211, srealityId: 58, srealityLocality: "district" },
    Rakovník: { name: "Rakovník", reasId: 3212, srealityId: 59, srealityLocality: "district" },

    // --- Jihočeský kraj (33xx) ---
    "České Budějovice": { name: "České Budějovice", reasId: 3301, srealityId: 1, srealityLocality: "district" },
    "Český Krumlov": { name: "Český Krumlov", reasId: 3302, srealityId: 2, srealityLocality: "district" },
    "Jindřichův Hradec": { name: "Jindřichův Hradec", reasId: 3303, srealityId: 3, srealityLocality: "district" },
    Pelhřimov: { name: "Pelhřimov", reasId: 3304, srealityId: 68, srealityLocality: "district" },
    Písek: { name: "Písek", reasId: 3305, srealityId: 4, srealityLocality: "district" },
    Prachatice: { name: "Prachatice", reasId: 3306, srealityId: 5, srealityLocality: "district" },
    Strakonice: { name: "Strakonice", reasId: 3307, srealityId: 6, srealityLocality: "district" },
    Tábor: { name: "Tábor", reasId: 3308, srealityId: 7, srealityLocality: "district" },

    // --- Plzeňský kraj (34xx) ---
    Domažlice: { name: "Domažlice", reasId: 3401, srealityId: 8, srealityLocality: "district" },
    Cheb: { name: "Cheb", reasId: 3402, srealityId: 9, srealityLocality: "district" },
    "Karlovy Vary": { name: "Karlovy Vary", reasId: 3403, srealityId: 10, srealityLocality: "district" },
    Klatovy: { name: "Klatovy", reasId: 3404, srealityId: 11, srealityLocality: "district" },
    Plzeň: { name: "Plzeň", reasId: 3405, srealityId: 12, srealityLocality: "district" },
    "Plzeň-jih": { name: "Plzeň-jih", reasId: 3406, srealityId: 13, srealityLocality: "district" },
    "Plzeň-sever": { name: "Plzeň-sever", reasId: 3407, srealityId: 14, srealityLocality: "district" },
    Rokycany: { name: "Rokycany", reasId: 3408, srealityId: 15, srealityLocality: "district" },
    Sokolov: { name: "Sokolov", reasId: 3409, srealityId: 16, srealityLocality: "district" },
    Tachov: { name: "Tachov", reasId: 3410, srealityId: 17, srealityLocality: "district" },

    // --- Ústecký + Liberecký kraj (35xx) ---
    "Česká Lípa": { name: "Česká Lípa", reasId: 3501, srealityId: 18, srealityLocality: "district" },
    Děčín: { name: "Děčín", reasId: 3502, srealityId: 19, srealityLocality: "district" },
    Chomutov: { name: "Chomutov", reasId: 3503, srealityId: 20, srealityLocality: "district" },
    "Jablonec nad Nisou": { name: "Jablonec nad Nisou", reasId: 3504, srealityId: 21, srealityLocality: "district" },
    Liberec: { name: "Liberec", reasId: 3505, srealityId: 22, srealityLocality: "district" },
    Litoměřice: { name: "Litoměřice", reasId: 3506, srealityId: 23, srealityLocality: "district" },
    Louny: { name: "Louny", reasId: 3507, srealityId: 24, srealityLocality: "district" },
    Most: { name: "Most", reasId: 3508, srealityId: 25, srealityLocality: "district" },
    Teplice: { name: "Teplice", reasId: 3509, srealityId: 26, srealityLocality: "district" },
    "Ústí nad Labem": { name: "Ústí nad Labem", reasId: 3510, srealityId: 27, srealityLocality: "district" },

    // --- Královéhradecký + Pardubický kraj (36xx) ---
    "Havlíčkův Brod": { name: "Havlíčkův Brod", reasId: 3601, srealityId: 66, srealityLocality: "district" },
    "Hradec Králové": { name: "Hradec Králové", reasId: 3602, srealityId: 28, srealityLocality: "district" },
    Chrudim: { name: "Chrudim", reasId: 3603, srealityId: 29, srealityLocality: "district" },
    Jičín: { name: "Jičín", reasId: 3604, srealityId: 30, srealityLocality: "district" },
    Náchod: { name: "Náchod", reasId: 3605, srealityId: 31, srealityLocality: "district" },
    Pardubice: { name: "Pardubice", reasId: 3606, srealityId: 32, srealityLocality: "district" },
    "Rychnov nad Kněžnou": { name: "Rychnov nad Kněžnou", reasId: 3607, srealityId: 33, srealityLocality: "district" },
    Semily: { name: "Semily", reasId: 3608, srealityId: 34, srealityLocality: "district" },
    Svitavy: { name: "Svitavy", reasId: 3609, srealityId: 35, srealityLocality: "district" },
    Trutnov: { name: "Trutnov", reasId: 3610, srealityId: 36, srealityLocality: "district" },
    "Ústí nad Orlicí": { name: "Ústí nad Orlicí", reasId: 3611, srealityId: 37, srealityLocality: "district" },

    // --- Jihomoravský + Zlínský kraj + Vysočina (37xx) ---
    Blansko: { name: "Blansko", reasId: 3701, srealityId: 71, srealityLocality: "district" },
    Brno: { name: "Brno", reasId: 3702, srealityId: 72, srealityLocality: "district" },
    "Brno-venkov": { name: "Brno-venkov", reasId: 3703, srealityId: 73, srealityLocality: "district" },
    Břeclav: { name: "Břeclav", reasId: 3704, srealityId: 74, srealityLocality: "district" },
    Zlín: { name: "Zlín", reasId: 3705, srealityId: 38, srealityLocality: "district" },
    Hodonín: { name: "Hodonín", reasId: 3706, srealityId: 75, srealityLocality: "district" },
    Jihlava: { name: "Jihlava", reasId: 3707, srealityId: 67, srealityLocality: "district" },
    Kroměříž: { name: "Kroměříž", reasId: 3708, srealityId: 39, srealityLocality: "district" },
    Prostějov: { name: "Prostějov", reasId: 3709, srealityId: 40, srealityLocality: "district" },
    Třebíč: { name: "Třebíč", reasId: 3710, srealityId: 69, srealityLocality: "district" },
    "Uherské Hradiště": { name: "Uherské Hradiště", reasId: 3711, srealityId: 41, srealityLocality: "district" },
    Vyškov: { name: "Vyškov", reasId: 3712, srealityId: 76, srealityLocality: "district" },
    Znojmo: { name: "Znojmo", reasId: 3713, srealityId: 77, srealityLocality: "district" },
    "Žďár nad Sázavou": { name: "Žďár nad Sázavou", reasId: 3714, srealityId: 70, srealityLocality: "district" },

    // --- Olomoucký + Moravskoslezský kraj (38xx) ---
    Bruntál: { name: "Bruntál", reasId: 3801, srealityId: 60, srealityLocality: "district" },
    "Frýdek-Místek": { name: "Frýdek-Místek", reasId: 3802, srealityId: 61, srealityLocality: "district" },
    Karviná: { name: "Karviná", reasId: 3803, srealityId: 62, srealityLocality: "district" },
    "Nový Jičín": { name: "Nový Jičín", reasId: 3804, srealityId: 63, srealityLocality: "district" },
    Olomouc: { name: "Olomouc", reasId: 3805, srealityId: 42, srealityLocality: "district" },
    Opava: { name: "Opava", reasId: 3806, srealityId: 64, srealityLocality: "district" },
    Ostrava: { name: "Ostrava", reasId: 3807, srealityId: 65, srealityLocality: "district" },
    Přerov: { name: "Přerov", reasId: 3808, srealityId: 43, srealityLocality: "district" },
    Šumperk: { name: "Šumperk", reasId: 3809, srealityId: 44, srealityLocality: "district" },
    Vsetín: { name: "Vsetín", reasId: 3810, srealityId: 45, srealityLocality: "district" },
    Jeseník: { name: "Jeseník", reasId: 3811, srealityId: 46, srealityLocality: "district" },
};

// ---------------------------------------------------------------------------
// Praha sub-districts (Praha 1–22)
// ---------------------------------------------------------------------------
// REAS: No per-ward IDs — all Praha data is under reasId=3100 (city-level)
// Sreality: Uses locality_quarter parameter via srealityQuarterId
// ---------------------------------------------------------------------------

export const PRAHA_DISTRICTS: Record<string, PrahaDistrictInfo> = {
    "Praha 1": {
        name: "Praha 1",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 1,
        srealityQuarterId: 87,
    },
    "Praha 2": {
        name: "Praha 2",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 2,
        srealityQuarterId: 88,
    },
    "Praha 3": {
        name: "Praha 3",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 3,
        srealityQuarterId: 89,
    },
    "Praha 4": {
        name: "Praha 4",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 4,
        srealityQuarterId: 90,
    },
    "Praha 5": {
        name: "Praha 5",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 5,
        srealityQuarterId: 97,
    },
    "Praha 6": {
        name: "Praha 6",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 6,
        srealityQuarterId: 107,
    },
    "Praha 7": {
        name: "Praha 7",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 7,
        srealityQuarterId: 113,
    },
    "Praha 8": {
        name: "Praha 8",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 8,
        srealityQuarterId: 115,
    },
    "Praha 9": {
        name: "Praha 9",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 9,
        srealityQuarterId: 119,
    },
    "Praha 10": {
        name: "Praha 10",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 10,
        srealityQuarterId: 132,
    },
    "Praha 11": {
        name: "Praha 11",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 11,
        srealityQuarterId: 91,
    },
    "Praha 12": {
        name: "Praha 12",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 12,
        srealityQuarterId: 92,
    },
    "Praha 13": {
        name: "Praha 13",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 13,
        srealityQuarterId: 98,
    },
    "Praha 14": {
        name: "Praha 14",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 14,
        srealityQuarterId: 120,
    },
    "Praha 15": {
        name: "Praha 15",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 15,
        srealityQuarterId: 133,
    },
    "Praha 16": {
        name: "Praha 16",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 16,
        srealityQuarterId: 101,
    },
    "Praha 17": {
        name: "Praha 17",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 17,
        srealityQuarterId: 111,
    },
    "Praha 18": {
        name: "Praha 18",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 18,
        srealityQuarterId: 128,
    },
    "Praha 19": {
        name: "Praha 19",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 19,
        srealityQuarterId: 125,
    },
    "Praha 20": {
        name: "Praha 20",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 20,
        srealityQuarterId: 124,
    },
    "Praha 21": {
        name: "Praha 21",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 21,
        srealityQuarterId: 130,
    },
    "Praha 22": {
        name: "Praha 22",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
        wardNumber: 22,
        srealityQuarterId: 80,
    },
};

// ---------------------------------------------------------------------------
// Neighborhood → Praha ward mapping
// ---------------------------------------------------------------------------
// Bezrealitky, Sreality SSR, and other providers use neighborhood names
// (e.g. "Praha - Žižkov") instead of ward numbers ("Praha 3").
// This mapping lets district matching recognize them.
// Source: https://cs.wikipedia.org/wiki/Městské_části_v_Praze

const PRAHA_NEIGHBORHOOD_TO_WARDS: Record<string, number[]> = {
    // Praha 1
    "Staré Město": [1],
    "Malá Strana": [1],
    Hradčany: [1],
    Josefov: [1],
    // Praha 2
    "Nové Město": [1, 2],
    Vyšehrad: [2],
    // Praha 3
    Žižkov: [3],
    Vinohrady: [2, 3, 10],
    // Praha 4
    Nusle: [4],
    Podolí: [4],
    Braník: [4],
    Krč: [4],
    Michle: [4],
    Lhotka: [4],
    Hodkovičky: [4],
    Kunratice: [4],
    Modřany: [4, 12],
    Chodov: [4, 11],
    // Praha 5
    Smíchov: [5],
    Košíře: [5],
    Motol: [5],
    Jinonice: [5],
    Radlice: [5],
    Hlubočepy: [5],
    Stodůlky: [5, 13],
    Barrandov: [5],
    // Praha 6
    Dejvice: [6],
    Bubeneč: [6],
    Vokovice: [6],
    Veleslavín: [6],
    Břevnov: [6],
    Střešovice: [6],
    Liboc: [6],
    Ruzyně: [6],
    // Praha 7
    Holešovice: [7],
    Letná: [7],
    Bubny: [7],
    Troja: [7],
    // Praha 8
    Karlín: [8],
    Libeň: [8],
    Kobylisy: [8],
    Bohnice: [8],
    Čimice: [8],
    Ďáblice: [8],
    "Dolní Chabry": [8],
    // Praha 9
    Vysočany: [9],
    Prosek: [9],
    Střížkov: [8, 9],
    Hloubětín: [9],
    Letňany: [9, 18],
    Kbely: [9, 19],
    "Černý Most": [9, 14],
    // Praha 10
    Vršovice: [10],
    Záběhlice: [10],
    Malešice: [10],
    Strašnice: [3, 10],
    Hostivař: [10, 15],
    "Dolní Měcholupy": [10],
    Štěrboholy: [10],
    // Praha 11
    "Jižní Město": [11],
    Háje: [11],
    // Praha 12
    Komořany: [12],
    Cholupice: [12],
    // Praha 13
    Řeporyje: [13],
    "Nové Butovice": [13],
    Třebonice: [13],
    // Praha 14
    Kyje: [14],
    Hostavice: [14],
    // Praha 15
    "Horní Měcholupy": [15],
    Petrovice: [15],
    // Praha 16
    Radotín: [16],
    Zbraslav: [16],
    Lipence: [16],
    // Praha 17
    Řepy: [17],
    Zličín: [17],
    // Praha 18
    Čakovice: [18],
    // Praha 19
    Vinoř: [19],
    Satalice: [19],
    // Praha 20
    "Horní Počernice": [20],
    // Praha 21
    Újezd: [21],
    Klánovice: [21],
    Koloděje: [21],
    // Praha 22
    Uhříněves: [22],
    Pitkovice: [22],
    Křeslice: [22],
};

/** Check if a Praha neighborhood belongs to a given ward number. */
export function neighborhoodMatchesWard(neighborhood: string, wardNumber: number): boolean {
    const wards = PRAHA_NEIGHBORHOOD_TO_WARDS[neighborhood];

    if (!wards) {
        return false;
    }

    return wards.includes(wardNumber);
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/** Exact name match (case-insensitive). Checks both DISTRICTS and PRAHA_DISTRICTS. */
export function getDistrict(name: string): DistrictInfo | undefined {
    const lower = name.toLowerCase();

    for (const [key, info] of Object.entries(DISTRICTS)) {
        if (key.toLowerCase() === lower) {
            return info;
        }
    }

    for (const [key, info] of Object.entries(PRAHA_DISTRICTS)) {
        if (key.toLowerCase() === lower) {
            return info;
        }
    }

    return undefined;
}

/** Fuzzy search — returns districts whose name contains the query. Results sorted: startsWith first, then alphabetical. */
export function searchDistricts(query: string): DistrictInfo[] {
    const lower = query.toLowerCase();
    const all: Record<string, DistrictInfo> = { ...DISTRICTS, ...PRAHA_DISTRICTS };

    return Object.values(all)
        .filter((d) => d.name.toLowerCase().includes(lower))
        .sort((a, b) => {
            const aStarts = a.name.toLowerCase().startsWith(lower) ? 0 : 1;
            const bStarts = b.name.toLowerCase().startsWith(lower) ? 0 : 1;

            return aStarts - bStarts || a.name.localeCompare(b.name, "cs");
        });
}

/** All district names (excluding Praha sub-districts), sorted alphabetically in Czech locale. */
export function getAllDistrictNames(): string[] {
    return Object.keys(DISTRICTS).sort((a, b) => a.localeCompare(b, "cs"));
}

/** Praha sub-district names, sorted by ward number. */
export function getPrahaDistrictNames(): string[] {
    return Object.entries(PRAHA_DISTRICTS)
        .sort(([, a], [, b]) => a.wardNumber - b.wardNumber)
        .map(([name]) => name);
}
