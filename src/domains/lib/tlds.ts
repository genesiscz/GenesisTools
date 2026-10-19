import { request, storage } from "@app/domains/lib/http";
import { logger } from "@genesiscz/utils/logger";

/** The TLDs `search` tries when you do not pass `--tlds`. */
export const DEFAULT_TLDS = [
    "com",
    "cz",
    "io",
    "dev",
    "app",
    "ai",
    "co",
    "tech",
    "sh",
    "so",
    "eu",
    "net",
    "org",
    "xyz",
];

/** A rough desirability tier per TLD, used by the ranker. Unlisted TLDs score 3. */
export const TLD_TIER: Record<string, number> = {
    com: 10,
    io: 8,
    ai: 8,
    dev: 8,
    co: 7,
    app: 7,
    sh: 7,
    so: 6,
    tech: 6,
    cz: 7,
    eu: 6,
    net: 6,
    org: 6,
    me: 5,
    gg: 5,
    xyz: 4,
    ch: 6,
    is: 5,
    ly: 5,
    to: 5,
    tools: 5,
    studio: 5,
    run: 5,
    build: 5,
    page: 4,
    site: 3,
    online: 2,
};

/** Offline fallback for hack search when the IANA list cannot be fetched: openly registrable ccTLDs. */
const FALLBACK_TLDS = [
    "ac ag ai am as at be bz ca cc ch cl cm cn co cx cz de dk es eu fi fm fr gd gg gl gs hn ht id ie",
    "im in io is it je jp kz la li lt lu lv ly ma md me mn ms mu mx nl nu nz pe ph pl pm pt pw re ro",
    "rs ru sc se sh si sk so st su sx tc tf tk tl tm to tv tw ua uk us uz vc vg vu wf ws yt app dev",
    "tech ink art fun life live lol new one page run zip mov foo how day boo dad esq phd prof nexus",
    "meme ing rest surf",
]
    .join(" ")
    .split(" ");

let allTldsPromise: Promise<string[]> | null = null;

/** Every delegated TLD from IANA (about 1,400), cached for a week; the ccTLD fallback when offline. */
export async function allTlds(): Promise<string[]> {
    allTldsPromise ??= (async () => {
        try {
            const text = await storage.getFileOrPut<string>(
                "iana/tlds.txt",
                async () => {
                    const response = await request("https://data.iana.org/TLD/tlds-alpha-by-domain.txt", {
                        label: "iana tlds",
                    });
                    if (response.status !== 200) {
                        throw new Error(`IANA TLD list: HTTP ${response.status}`);
                    }

                    return response.text;
                },
                "7 days"
            );
            return text
                .split("\n")
                .map((line) => line.trim().toLowerCase())
                .filter((line) => line && !line.startsWith("#") && !line.startsWith("xn--"));
        } catch (error) {
            logger.warn({ error }, "domains: IANA TLD list unavailable, using the built-in list");
            return FALLBACK_TLDS;
        }
    })();
    return allTldsPromise;
}

export function tldTier(tld: string): number {
    return TLD_TIER[tld] ?? (tld.length === 2 ? 4 : 3);
}
