import { foldAscii } from "@app/domains/lib/domain";
import { request, storage } from "@app/domains/lib/http";
import { logger } from "@genesiscz/utils/logger";

const LIST_BASE =
    "https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master";

/** Latin-script languages the LDNOOBW lists cover; a label is ASCII, so other scripts cannot match. */
export const VIBE_LANGUAGES = [
    "en",
    "cs",
    "de",
    "es",
    "fr",
    "it",
    "nl",
    "pl",
    "pt",
    "sv",
    "da",
    "fi",
    "hu",
    "no",
    "tr",
    "eo",
];

/**
 * Offline floor so the check still catches the obvious when GitHub is unreachable.
 * "bereshit" reads "bere shit" (takes shit) to a Czech speaker, which is why this check exists.
 */
const BUILT_IN: Record<string, string[]> = {
    en: ["shit", "fuck", "cunt", "dick", "piss", "slut", "whore", "bitch", "anal", "porn", "crap"],
    cs: ["kurva", "prdel", "hovno", "sracka", "pica", "kokot", "curak", "debil", "zmrd", "mrdat", "chcat", "kunda"],
    de: ["scheisse", "arsch", "fotze", "wichser", "kacke", "fick"],
    es: ["mierda", "puta", "joder", "cono", "polla", "culo"],
};

export interface VibeHit {
    /** Every list that contains the word. */
    languages: string[];
    word: string;
    /** Where it sits in the label: "whole", "start", "end" or "inside". */
    position: "whole" | "start" | "end" | "inside";
}

function fold(text: string): string {
    return foldAscii(text).replace(/[^a-z]/g, "");
}

async function wordList(language: string): Promise<{ words: string[]; fromList: boolean }> {
    try {
        const text = await storage.getFileOrPut<string>(
            `vibe/${language}.txt`,
            async () => {
                const response = await request(`${LIST_BASE}/${language}`, { label: "vibe list" });
                if (response.status !== 200) {
                    throw new Error(`HTTP ${response.status}`);
                }

                return response.text;
            },
            "4 weeks"
        );
        const words = [...new Set([...text.split("\n").map(fold), ...(BUILT_IN[language] ?? [])])].filter(Boolean);
        return { words, fromList: true };
    } catch (error) {
        logger.debug({ language, error }, "domains: vibe list unavailable, using the built-in words");
        return { words: BUILT_IN[language] ?? [], fromList: false };
    }
}

const listLoads = new Map<string, Promise<string[]>>();

/** Every concurrent check shares one load per language; a fallback is forgotten so a later call retries. */
function sharedWordList(language: string): Promise<string[]> {
    let load = listLoads.get(language);
    if (!load) {
        load = wordList(language).then(({ words, fromList }) => {
            if (!fromList) {
                listLoads.delete(language);
            }

            return words;
        });
        listLoads.set(language, load);
    }

    return load;
}

/**
 * Pure matcher. Words of 4+ letters match anywhere; 3-letter words only as the whole label, because
 * short words hide inside innocent ones ("ass" in "class", "assist", "bass").
 */
/** Innocent words that contain a listed word; a match inside one of them does not count. */
const INNOCENT = [
    "analy",
    "banal",
    "canal",
    "scrap",
    "grape",
    "drape",
    "therapist",
    "dickens",
    "scunthorpe",
    "janus",
    "cockpit",
    "cocktail",
    "peacock",
    "hancock",
    "basement",
    "spice",
    "spicy",
    "button",
    "buttress",
];

export function findVibeHits(label: string, lists: Record<string, string[]>): VibeHit[] {
    const folded = fold(label);
    // Innocent words are blanked out with a non-letter, so a word can match beside them but not inside them.
    const masked = INNOCENT.reduce((text, safe) => text.replaceAll(safe, "_".repeat(safe.length)), folded);
    const hits = new Map<string, VibeHit>();
    for (const [language, words] of Object.entries(lists)) {
        for (const word of words) {
            if (word.length < 3 || !masked.includes(word)) {
                continue;
            }

            const position =
                folded === word
                    ? "whole"
                    : masked.startsWith(word)
                      ? "start"
                      : masked.endsWith(word)
                        ? "end"
                        : "inside";
            if (word.length === 3 && position !== "whole") {
                continue;
            }

            const existing = hits.get(word);
            if (existing) {
                existing.languages.push(language);
            } else {
                hits.set(word, { languages: [language], word, position });
            }
        }
    }

    return [...hits.values()].sort((a, b) => b.word.length - a.word.length);
}

export async function vibeCheck(label: string, languages: string[] = VIBE_LANGUAGES): Promise<VibeHit[]> {
    const lists: Record<string, string[]> = {};
    await Promise.all(
        languages.map(async (language) => {
            lists[language] = await sharedWordList(language);
        })
    );
    return findVibeHits(label, lists);
}
