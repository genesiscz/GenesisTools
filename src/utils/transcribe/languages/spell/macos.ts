import { dlopen } from "bun:ffi";
import type { SpellEngine, SpellProvider } from "./types";

const LIBOBJC = "/usr/lib/libobjc.A.dylib";
const APPKIT = "/System/Library/Frameworks/AppKit.framework/AppKit";
/** `NSNotFound`, the location of "no misspelling": NSIntegerMax, read here as an unsigned 64-bit value. */
const NOT_FOUND = 2 ** 62;

interface Runtime {
    checker: number;
    makeString(value: string): number;
    /** The UTF-16 offset of the first misspelled word at or after `start`, or NOT_FOUND or more. */
    firstMisspelling(text: number, start: number, language: number): number;
}

let runtime: Runtime | undefined;

function objc(): Runtime {
    if (runtime) {
        return runtime;
    }

    const rt = dlopen(LIBOBJC, {
        objc_getClass: { args: ["cstring"], returns: "ptr" },
        sel_registerName: { args: ["cstring"], returns: "ptr" },
    }).symbols;
    dlopen(APPKIT, { NSApplicationLoad: { args: [], returns: "bool" } }).symbols.NSApplicationLoad();

    // objc_msgSend takes the arguments of the selector it sends, so each signature is its own binding.
    const send = dlopen(LIBOBJC, { objc_msgSend: { args: ["ptr", "ptr"], returns: "ptr" } }).symbols.objc_msgSend;
    const sendString = dlopen(LIBOBJC, { objc_msgSend: { args: ["ptr", "ptr", "cstring"], returns: "ptr" } }).symbols
        .objc_msgSend;
    // checkSpellingOfString:startingAt:language:wrap:inSpellDocumentWithTag:wordCount: returns an NSRange; its
    // location comes back in the first return register on arm64 and x86_64.
    const sendCheck = dlopen(LIBOBJC, {
        objc_msgSend: { args: ["ptr", "ptr", "ptr", "i64", "ptr", "bool", "i64", "ptr"], returns: "u64" },
    }).symbols.objc_msgSend;
    const sel = (name: string) => rt.sel_registerName(Buffer.from(`${name}\0`));
    const cls = (name: string) => rt.objc_getClass(Buffer.from(`${name}\0`));
    const nsString = cls("NSString");
    const fromUtf8 = sel("stringWithUTF8String:");
    const check = sel("checkSpellingOfString:startingAt:language:wrap:inSpellDocumentWithTag:wordCount:");
    const checker = send(cls("NSSpellChecker"), sel("sharedSpellChecker"));

    if (!checker) {
        throw new Error("NSSpellChecker is not available");
    }

    runtime = {
        checker,
        makeString: (value) => sendString(nsString, fromUtf8, Buffer.from(`${value}\0`)) as number,
        firstMisspelling: (text, start, language) =>
            Number(sendCheck(checker, check, text, start, language, false, 0, null)),
    };

    return runtime;
}

/** The index of the word whose span holds `offset`, `starts` being the words' start offsets in order. */
function wordIndexAt(starts: number[], offset: number): number {
    let low = 0;
    let high = starts.length - 1;

    while (low < high) {
        const middle = Math.ceil((low + high) / 2);

        if (starts[middle]! <= offset) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }

    return low;
}

/** The macOS system spell checker over bun:ffi: nothing to download, macOS only. */
export const macos: SpellProvider = {
    id: "macos",
    description: "The macOS system spell checker (NSSpellChecker), called through bun:ffi",
    unavailable: (language) => {
        if (process.platform !== "darwin") {
            return "the macos spell checker runs on macOS only";
        }

        return /^[a-z]{2,3}$/.test(language) ? undefined : `"${language}" is not a language code`;
    },
    async open(language): Promise<SpellEngine> {
        const { makeString, firstMisspelling } = objc();
        // An explicit language: without it the checker identifies the language per word and accepts English
        // words and mixed-case acronyms ("DTLčko") in a Czech text.
        const lang = makeString(language);

        return {
            accepted(words) {
                // The checker skips words with a capital after the first letter ("OHP", "DTLe") and words with
                // digits, so it cannot vouch for them.
                const unique = [...new Set(words)].filter(
                    (word) => word.length > 0 && !/\s/.test(word) && !/\d/.test(word) && !/.\p{Lu}/u.test(word)
                );
                const text = unique.join(" ");
                const starts: number[] = [];
                let offset = 0;

                for (const word of unique) {
                    starts.push(offset);
                    offset += word.length + 1;
                }

                const misspelled = new Set<number>();
                const nsText = makeString(text);
                let start = 0;

                while (start < text.length) {
                    const location = firstMisspelling(nsText, start, lang);

                    if (location >= NOT_FOUND || location < start) {
                        break;
                    }

                    // A flagged range can start inside a word ("ho-ho", "DTLčko"): the whole word fails.
                    const index = wordIndexAt(starts, location);
                    misspelled.add(index);
                    // From the space after the word: a start on a word's first letter skips that word.
                    start = starts[index]! + unique[index]!.length;
                }

                return new Set(unique.filter((_word, index) => !misspelled.has(index)));
            },
            dispose: () => undefined,
        };
    },
};
