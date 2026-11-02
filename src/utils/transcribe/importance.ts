/**
 * Words that tell whether a stretch of speech matters: fillers that carry nothing, and words of a decision or an
 * action. One table per language; a line is checked against all of them, since a meeting mixes languages.
 */
const LANGUAGES = {
    cs: {
        fillers: [
            "jo",
            "no",
            "hm",
            "hmm",
            "mhm",
            "aha",
            "ano",
            "jasně",
            "dobře",
            "okej",
            "ok",
            "čau",
            "eh",
            "ehm",
            "jj",
            "ne",
            "tak",
            "super",
            "díky",
        ],
        decision: [
            "domluv\\p{L}*",
            "souhlas\\p{L}*",
            "rozhodn\\p{L}*",
            "připrav\\p{L}*",
            "navrh\\p{L}*",
            "dohod\\p{L}*",
            "uděláme",
            "udělám",
            "zavolám",
            "napíšu",
            "pošlu",
            "zítra",
            "musíme",
            "termín\\p{L}*",
        ],
    },
    en: {
        fillers: ["yeah", "yes", "no", "ok", "okay", "right", "sure", "uh", "um", "hmm", "mhm", "thanks"],
        decision: ["agree\\p{L}*", "decid\\p{L}*", "deadline", "tomorrow", "we'll", "i'll", "send", "deliver\\p{L}*"],
    },
} as const;

const FILLERS = new Set<string>(Object.values(LANGUAGES).flatMap((language) => [...language.fillers]));
const DECISION = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${Object.values(LANGUAGES)
        .flatMap((language) => [...language.decision])
        .join("|")})(?![\\p{L}\\p{N}])`,
    "iu"
);

export interface Importance {
    words: number;
    /** Every word is a filler ("jo, no, mhm"). */
    fillersOnly: boolean;
    /** A decision or action word is in it ("domluvíme", "pošlu", "zítra"). */
    decision: boolean;
}

export function importanceOf(text: string): Importance {
    const words = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
    return {
        words: words.length,
        fillersOnly: words.length > 0 && words.every((word) => FILLERS.has(word)),
        decision: DECISION.test(text),
    };
}
