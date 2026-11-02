// Czech: what the transcript checks need to know about the language. One file per language code.

import type { Download } from "./downloads";
import type { LanguageRules } from "./types";

/** Czech endings stripped before a fuzzy comparison, longest first: "jenezetkou" and "jenezetka" share "jenezet". */
export const CZECH_ENDINGS = [
    "kama",
    "kami",
    "kách",
    "ečko",
    "čkem",
    "čko",
    "čka",
    "kou",
    "ama",
    "ami",
    "ách",
    "ům",
    "em",
    "ou",
    "ka",
    "ky",
    "ku",
    "ce",
    "u",
    "y",
    "a",
    "e",
    "i",
    "o",
];
/** A stem shorter than this compares too loosely to mean anything. */
export const MIN_STEM = 4;

/** Lower case, no diacritics, no Czech ending. */
export function stemOf(word: string): string {
    const plain = word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    const ending = CZECH_ENDINGS.map((end) => end.normalize("NFD").replace(/\p{M}/gu, "")).find(
        (end) => plain.endsWith(end) && plain.length - end.length >= MIN_STEM - 1
    );
    return ending ? plain.slice(0, -ending.length) : plain;
}

/** Spoken Czech endings and the written endings they stand for ("jakej" for "jaký", "navrhnem" for "navrhneme"). */
const SPOKEN_ENDINGS: Array<[RegExp, string[]]> = [
    [/ejch$/u, ["ých"]],
    [/ejma$/u, ["ými"]],
    [/ejm$/u, ["ým"]],
    [/ýho$/u, ["ého"]],
    [/ýmu$/u, ["ému"]],
    [/ej$/u, ["ý", "é"]],
    [/ý$/u, ["é"]],
    [/ěj$/u, ["í"]],
    [/aj$/u, ["ají"]],
    [/em$/u, ["eme"]],
    [/ama$/u, ["ami", "y"]],
];

const SPOKEN_WORDS = new Map([
    ["bysme", "bychom"],
    ["abysme", "abychom"],
    ["kdybysme", "kdybychom"],
    ["sme", "jsme"],
    ["dyť", "vždyť"],
    ["dycky", "vždycky"],
    ["dyž", "když"],
    ["jesi", "jestli"],
]);

function writtenForms(word: string): string[] {
    const lower = word.toLowerCase();
    const forms = new Set<string>();
    const known = SPOKEN_WORDS.get(lower);

    if (known) {
        forms.add(known);
    }

    for (const [ending, written] of SPOKEN_ENDINGS) {
        if (ending.test(lower)) {
            for (const form of written) {
                forms.add(lower.replace(ending, form));
            }
        }
    }

    // A spoken "v" before an initial "o" ("vočůrat", "von").
    if (/^vo\p{L}{3,}/u.test(lower)) {
        forms.add(lower.slice(1));
    }

    // A spoken "ej" for "ý" inside the word ("zamejšlel", "bejt"), one place at a time.
    for (const match of lower.matchAll(/ej(?=\p{L})/gu)) {
        forms.add(`${lower.slice(0, match.index)}ý${lower.slice(match.index + 2)}`);
    }

    forms.delete(lower);

    return [...forms];
}

/** Czech prefixes on a borrowed verb ("namockovat", "zamergovat", "vysdílet"). "ne" is left out: "nepeníze". */
const LOAN_PREFIXES = [
    "pře",
    "při",
    "pre",
    "roz",
    "pod",
    "nad",
    "vy",
    "na",
    "za",
    "pro",
    "od",
    "po",
    "do",
    "re",
    "u",
    "z",
    "s",
];
/** Czech endings on a borrowed word ("backendový", "endpointu", "mockovanej", "stagovat"), longest first. */
const LOAN_ENDINGS = [
    "ovanejch",
    "ování",
    "nutýho",
    "nutej",
    "nutý",
    "nutá",
    "nuté",
    "kového",
    "kových",
    "kovým",
    "kovou",
    "ková",
    "kové",
    "kový",
    "ovaných",
    "ovanou",
    "ovanej",
    "ovaný",
    "ovaná",
    "ované",
    "ovací",
    "ovala",
    "ovali",
    "ovat",
    "oval",
    "ového",
    "ovému",
    "ových",
    "ovými",
    "ovským",
    "ovský",
    "ovská",
    "ovské",
    "ovým",
    "ovou",
    "ovej",
    "ová",
    "ové",
    "ový",
    "ově",
    "ujeme",
    "ujete",
    "ujou",
    "uješ",
    "uje",
    "uju",
    "uji",
    "neme",
    "nete",
    "nout",
    "neš",
    "nem",
    "nul",
    "nu",
    "ne",
    "ni",
    "ťáci",
    "ťák",
    "áci",
    "ák",
    "čkách",
    "čkama",
    "čkem",
    "ečko",
    "ečka",
    "čka",
    "čko",
    "čku",
    "ček",
    "kách",
    "kama",
    "kem",
    "ách",
    "ech",
    "ama",
    "ami",
    "ům",
    "em",
    "ou",
    "ím",
    "íš",
    "ko",
    "ka",
    "ku",
    "ky",
    "ů",
    "í",
    "ě",
    "u",
    "y",
    "a",
    "e",
    "i",
    "o",
];
const LOAN_MIN_STEM = 3;

/** "UI" in "UIčko", "ID" in "IDčkem": a stem in capitals stays short. */
function isAcronym(stem: string): boolean {
    return /^\p{Lu}{2,}$/u.test(stem);
}

function loanStems(word: string): string[] {
    const stems = new Set<string>();
    const lower = word.toLowerCase();

    // An English plural said as it is ("booleans").
    if (/[^s]s$/u.test(lower) && word.length > 4) {
        stems.add(word.slice(0, -1));
    }

    for (const prefix of ["", ...LOAN_PREFIXES]) {
        if (!lower.startsWith(prefix)) {
            continue;
        }

        const rest = word.slice(prefix.length);

        for (const ending of LOAN_ENDINGS) {
            const stem = rest.slice(0, rest.length - ending.length);

            if (rest.toLowerCase().endsWith(ending) && stem.length >= (isAcronym(stem) ? 2 : LOAN_MIN_STEM)) {
                stems.add(stem);

                // The English word often ends in a silent "e" the Czech form drops: "mergovat", "featuru".
                if (!isAcronym(stem)) {
                    stems.add(`${stem}e`);
                }
            }
        }
    }

    return [...stems];
}

/** The words left once one or two Czech prefixes are gone ("vysdílím", "renamodelujeme"), for the dictionary. */
function prefixedRoots(word: string): string[] {
    const strip = (lower: string) =>
        LOAN_PREFIXES.filter((prefix) => lower.startsWith(prefix) && lower.length - prefix.length >= 4).map((prefix) =>
            lower.slice(prefix.length)
        );
    const once = strip(word.toLowerCase());

    return [...new Set([...once, ...once.flatMap(strip)])];
}

/** OpenSubtitles word counts, so spoken forms ("jakej", "bysme", "můžem") count as real speech. */
const WORD_LIST: Download = {
    file: "frequency-words/cs_full.txt",
    url: "https://raw.githubusercontent.com/hermitdave/FrequencyWords/525f9b560de45753a5ea01069454e72e9aa541c6/content/2018/cs/cs_full.txt",
    sha256: "3080cc08fec2afddfdcea07c0e80de414ae7ad850fc6d646e43367b238004bb8",
    license: "CC-BY-SA-4.0",
};

export const CZECH: LanguageRules = {
    code: "cs",
    loanLanguage: "en",
    wordList: WORD_LIST,
    writtenForms,
    prefixedRoots,
    loanStems,
};
