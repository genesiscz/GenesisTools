/**
 * Read one origin's IndexedDB out of a browser profile that has NO debug port (the user's own
 * Brave or Chrome, which must keep running): copy the origin's leveldb folders into a scratch
 * user-data-dir, open that copy in a headless browser, serve blank documents for the origin so
 * none of its code runs and no network is used, and dump.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serveBlankDocuments } from "@genesiscz/utils/chrome-devtools/intercept";
import {
    type CopyOriginIndexedDbResult,
    copyOriginIndexedDb,
    dumpIndexedDb,
    type IdbDump,
    type IdbDumpArgs,
    originStorageKey,
} from "@genesiscz/utils/chrome-devtools/storage";
import { logger } from "@genesiscz/utils/logger";
import { Conn, nextLoadEvent, Page, targets } from "./cdp.ts";
import { cdpLikeOf } from "./cdp-like-adapter.ts";
import { launchHeadlessChrome } from "./headless.ts";
import { CAPTURE_ROOT } from "./paths.ts";
import { type BrowserId, browserById, browserExecutable, installedBrowsers } from "./resolve-attach.ts";

const { log } = logger.scoped("chrome-devtools:profile-idb");

const LOAD_TIMEOUT_MS = 15_000;

export interface ReadProfileIdbOptions {
    /** The source PROFILE folder, the one holding `IndexedDB/`, e.g. `.../Brave-Browser/Default`. */
    profileDir: string;
    /** Any URL of the origin; only its origin is used. */
    origin: string;
    /** The headless browser that reads the copy. Default chrome. */
    browser?: BrowserId;
    args?: IdbDumpArgs;
    /** Where the scratch user-data-dir is made. Default `<capture root>/idb-copies`. */
    scratchRoot?: string;
    /** Reports each step as it happens, for the CLI's progress lines. */
    onStep?: (message: string) => void;
}

export interface ProfileIdbRead {
    dump: IdbDump;
    copy: CopyOriginIndexedDbResult;
    /** The scratch user-data-dir holding the copy. Kept after the read; the source is never touched. */
    userDataDir: string;
    binary: string;
}

/** The scratch user-data-dir root for profile copies; 0700 because a copied IndexedDB can hold session tokens. */
export function profileCopyRoot(): string {
    return join(CAPTURE_ROOT, "idb-copies");
}

function headlessBinary(id: BrowserId): string {
    const def = browserById(id);

    if (!def) {
        throw new Error(`unknown browser '${id}'; installed here: ${installedBrowsers().join(", ") || "none"}`);
    }

    const binary = browserExecutable({ browser: def });

    if (!binary) {
        throw new Error(
            `no ${def.app} executable on this machine; installed here: ${installedBrowsers().join(", ") || "none"}`
        );
    }

    return binary;
}

async function dumpThroughBlankDocument(options: {
    port: number;
    origin: string;
    args: IdbDumpArgs;
}): Promise<IdbDump> {
    const target = (await targets(options.port)).find((candidate) => candidate.type === "page");

    if (!target) {
        throw new Error(`the headless browser on ${options.port} opened no page`);
    }

    const page = new Page(new Conn(target.webSocketDebuggerUrl), target);

    try {
        const cdp = cdpLikeOf(page);
        const blank = await serveBlankDocuments(cdp, `${options.origin}/*`);

        try {
            await page.send("Page.enable");
            const loaded = nextLoadEvent(page, LOAD_TIMEOUT_MS);
            await page.navigate(`${options.origin}/`);

            if (!(await loaded)) {
                throw new Error(
                    `${options.origin}/ did not load within ${LOAD_TIMEOUT_MS / 1000}s in the headless browser`
                );
            }

            const at = await page.evaluate("location.origin");

            if (at !== options.origin) {
                throw new Error(`the headless page is on ${String(at)}, not ${options.origin}`);
            }

            return await dumpIndexedDb(cdp, options.args);
        } finally {
            await blank.stop();
            log.debug({ stats: blank.stats }, "blank-document interception finished");
        }
    } finally {
        page.close();
    }
}

export async function readProfileIndexedDb(options: ReadProfileIdbOptions): Promise<ProfileIdbRead> {
    const origin = new URL(options.origin).origin;

    if (origin === "null") {
        throw new Error(`${options.origin} has no web origin; pass an http(s) URL`);
    }

    const binary = headlessBinary(options.browser ?? "chrome");
    const root = options.scratchRoot ?? profileCopyRoot();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const userDataDir = join(root, `${originStorageKey(origin)}-${stamp}`);

    const copy = await copyOriginIndexedDb({ profileDir: options.profileDir, origin, userDataDir });
    log.debug(
        { origin, profileDir: options.profileDir, userDataDir, onDiskBytes: copy.onDiskBytes },
        "IndexedDB copied"
    );
    options.onStep?.(`copied ${copy.copied.length} folder(s), ${copy.onDiskBytes} bytes on disk, to ${userDataDir}`);

    const chrome = await launchHeadlessChrome({ binary, userDataDir });
    options.onStep?.(`headless ${binary.split("/").pop()} on port ${chrome.port}`);

    try {
        const dump = await dumpThroughBlankDocument({ port: chrome.port, origin, args: options.args ?? {} });
        log.debug({ origin, databases: dump.databases.length }, "IndexedDB read from the copy");

        return { dump, copy, userDataDir, binary };
    } finally {
        await chrome.close();
    }
}
