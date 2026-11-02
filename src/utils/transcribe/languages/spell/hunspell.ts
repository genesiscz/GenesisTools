import { createHunspellFromFiles } from "hunspell-wasm";
import { type Download, ensureDownload } from "../downloads";
import type { SpellEngine, SpellProvider } from "./types";

interface HunspellFiles {
    aff: Download;
    dic: Download;
}

const WOOORM = "https://raw.githubusercontent.com/wooorm/dictionaries/836d7c2032167880e639a1fe522748733e528c2d";
const CC0 = "https://gitlab.com/strepon/czech-cc0-dictionaries/-/raw/3705e3f61c5d5ede438b645732e6e75ab62de58d";

const WOOORM_EN: HunspellFiles = {
    aff: {
        file: "hunspell/dictionary-en/en.aff",
        url: `${WOOORM}/dictionaries/en/index.aff`,
        sha256: "8ae1f19d4840d957728ad90555d5a8dff6cc5c046279c95ff0c00fc0a0136c7b",
        license: "MIT AND BSD",
    },
    dic: {
        file: "hunspell/dictionary-en/en.dic",
        url: `${WOOORM}/dictionaries/en/index.dic`,
        sha256: "f0b1a234bd178bdd01875b2a392a9647f888b8fe879f79c52aae62c2759b3647",
        license: "MIT AND BSD",
    },
};

const DICTIONARY_CS: Record<string, HunspellFiles> = {
    cs: {
        aff: {
            file: "hunspell/dictionary-cs/cs.aff",
            url: `${WOOORM}/dictionaries/cs/index.aff`,
            sha256: "175e02acb4786042a9c87e3cb6d3746e3a5b3079752118c2d4f0bb2c756ce72b",
            license: "GPL-2.0",
        },
        dic: {
            file: "hunspell/dictionary-cs/cs.dic",
            url: `${WOOORM}/dictionaries/cs/index.dic`,
            sha256: "bbc0a495671c29337279182799e171c173a21ae8968c89dd0fb7c713b40c7832",
            license: "GPL-2.0",
        },
    },
    en: WOOORM_EN,
};

const CZECH_CC0: Record<string, HunspellFiles> = {
    cs: {
        aff: {
            file: "hunspell/czech-cc0/cs.aff",
            url: `${CC0}/hunspell/cs_CZ.aff`,
            sha256: "38b16f59adb8d32e98506a2a39ad9ce7cef01b436489fe6fd2110b07607b7d46",
            license: "CC0-1.0",
        },
        dic: {
            file: "hunspell/czech-cc0/cs.dic",
            url: `${CC0}/hunspell/cs_CZ.dic`,
            sha256: "6676e0c91a2312053b94bea6c20fbced25b143bda77d12a4160ba2fcc194b943",
            license: "CC0-1.0",
        },
    },
    en: WOOORM_EN,
};

/** Hunspell compiled to WebAssembly: runs on every system, with dictionaries fetched on first use. */
function hunspellProvider(options: {
    id: string;
    description: string;
    dictionaries: Record<string, HunspellFiles>;
}): SpellProvider {
    return {
        id: options.id,
        description: options.description,
        unavailable: (language) =>
            options.dictionaries[language] ? undefined : `${options.id} has no "${language}" dictionary`,
        async open(language): Promise<SpellEngine> {
            const files = options.dictionaries[language];

            if (!files) {
                throw new Error(`${options.id} has no "${language}" dictionary`);
            }

            const hunspell = await createHunspellFromFiles(
                await ensureDownload(files.aff),
                await ensureDownload(files.dic)
            );

            return {
                accepted: (words) => new Set(words.filter((word) => word.length > 0 && hunspell.testSpelling(word))),
                dispose: () => hunspell.dispose(),
            };
        },
    };
}

export const hunspell = hunspellProvider({
    id: "hunspell",
    description: "Hunspell (WebAssembly) with the dictionary-cs Czech dictionary, GPL-2.0, downloaded on first use",
    dictionaries: DICTIONARY_CS,
});

export const hunspellCc0 = hunspellProvider({
    id: "hunspell-cc0",
    description: "Hunspell (WebAssembly) with the experimental CC0 Czech dictionary, downloaded on first use",
    dictionaries: CZECH_CC0,
});
