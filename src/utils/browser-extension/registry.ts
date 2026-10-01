import { createHash } from "node:crypto";
import { join } from "node:path";

/** The checkout, which holds every extension's sources and `dist`. */
const REPO = join(import.meta.dir, "..", "..", "..");

/**
 * An unpacked extension without a `key` gets its id from its folder: the first 32 hex digits of the
 * sha256 of the absolute path, each digit mapped onto a to p. Checked against Brave for `dist/extension`.
 */
export function unpackedExtensionId(path: string): string {
    const hex = createHash("sha256").update(path).digest("hex").slice(0, 32);
    return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}

export interface BrowserExtensionEntry {
    key: string;
    name: string;
    sourceDir: string;
    /** The folder loaded unpacked in the browser. */
    distDir: string;
    id: string;
    /** `tools` arguments that build `distDir`. */
    buildArgs: string[];
    /** `tools` arguments that reload it in the running browser over DevTools. */
    reloadArgs: string[];
    /** A page of the extension to open when its worker is asleep and a reload needs a context. */
    reloadPage: string;
    /** Where the running extension asks whether it is current: its native host, or nowhere yet. */
    status: "native-host" | "none";
    /** What stops working without it, for status lines. */
    purpose: string;
}

/** The GenesisTools extension pins its id with the manifest `key` (`src/browser-extension/extension/manifest.json`). */
export const GENESIS_EXTENSION_ID = "nhjllpnekfohbnljgelfpcdfhagbojne";

const YOUTUBE_DIST = join(REPO, "dist", "extension");

export const BROWSER_EXTENSIONS: readonly BrowserExtensionEntry[] = [
    {
        key: "genesis-tools",
        name: "GenesisTools",
        sourceDir: join(REPO, "src", "browser-extension", "extension"),
        distDir: join(REPO, "dist", "browser-extension"),
        id: GENESIS_EXTENSION_ID,
        buildArgs: ["browser-extension", "build"],
        reloadArgs: ["browser-extension", "reload"],
        reloadPage: "options.html",
        status: "native-host",
        purpose:
            "links clicked in other apps work without it; links typed in the address bar or clicked inside a page need it",
    },
    {
        key: "youtube",
        name: "GenesisTools YouTube",
        sourceDir: join(REPO, "src", "youtube", "extension"),
        distDir: YOUTUBE_DIST,
        id: unpackedExtensionId(YOUTUBE_DIST),
        buildArgs: ["youtube", "extension", "build"],
        reloadArgs: ["youtube", "extension", "reload"],
        reloadPage: "popup/popup.html",
        status: "none",
        purpose: "the YouTube side panel and player tools need it",
    },
];

export function extensionByKey(key: string): BrowserExtensionEntry | undefined {
    return BROWSER_EXTENSIONS.find((entry) => entry.key === key);
}
