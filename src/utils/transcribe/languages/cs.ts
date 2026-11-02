// Czech: what the transcript checks need to know about the language. One file per language code.

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
