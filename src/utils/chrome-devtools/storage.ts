import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { profiler } from "@genesiscz/utils/profile";
import type { CdpLike } from "./cdp-like.ts";
import { addInitScript, callInPage, type InitScript, type InPageCallOptions } from "./evaluate.ts";
import { type ClearStorageArgs, clearStorageKeys } from "./in-page/clear-storage.ts";
import { type IdbDump, type IdbDumpArgs, idbDump } from "./in-page/idb-dump.ts";
import { type WebStorageArgs, type WebStorageDump, webStorageDump } from "./in-page/web-storage.ts";

const prof = profiler.scope("chrome-devtools");

export type { ClearStorageArgs } from "./in-page/clear-storage.ts";
export type { IdbDatabaseDump, IdbDump, IdbDumpArgs, IdbRow, IdbStoreDump } from "./in-page/idb-dump.ts";
export type { WebStorageArea, WebStorageArgs, WebStorageDump, WebStorageEntry } from "./in-page/web-storage.ts";

/** Dumps the IndexedDB of the page's origin, read-only. No value cap unless `maxValueBytes` is set. */
export function dumpIndexedDb(cdp: CdpLike, args: IdbDumpArgs = {}, options: InPageCallOptions = {}): Promise<IdbDump> {
    return callInPage(cdp, idbDump, args, { timeoutMs: options.timeoutMs ?? 120_000 });
}

/** Dumps localStorage and sessionStorage of the page's origin. */
export function dumpWebStorage(
    cdp: CdpLike,
    args: WebStorageArgs = {},
    options: InPageCallOptions = {}
): Promise<WebStorageDump> {
    return callInPage(cdp, webStorageDump, args, options);
}

/**
 * The folder-name stem Chromium uses for an origin's storage: `https://app.example.com` becomes
 * `https_app.example.com_0` (0 = the scheme's default port), `http://localhost:3000` becomes
 * `http_localhost_3000`.
 */
export function originStorageKey(origin: string): string {
    const url = new URL(origin);
    const scheme = url.protocol.replace(/:$/, "");
    return `${scheme}_${url.hostname}_${url.port || "0"}`;
}

export interface CopyOriginIndexedDbOptions {
    /** The source PROFILE folder (the one holding `IndexedDB/`), e.g. `.../Brave-Browser/Default`. */
    profileDir: string;
    origin: string;
    /** A new user-data-dir for a throwaway browser. The copy lands in `<userDataDir>/<profileName>/IndexedDB/`. */
    userDataDir: string;
    /** Default `Default`. */
    profileName?: string;
}

export interface CopiedFolder {
    from: string;
    to: string;
    files: number;
    bytes: number;
}

export interface CopyOriginIndexedDbResult {
    copied: CopiedFolder[];
    /** Bytes on disk. NOT the data size: leveldb appends a full copy of each write to its log. */
    onDiskBytes: number;
    /** The URL path the caller should open must be a static file of `origin`, so the app never runs. */
    origin: string;
}

async function folderStats(dir: string): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) {
            files++;
            bytes += (await stat(join(entry.parentPath, entry.name))).size;
        }
    }

    return { files, bytes };
}

async function exists(path: string): Promise<boolean> {
    return stat(path).then(
        () => true,
        () => false
    );
}

/**
 * Copies one origin's IndexedDB folders (`<key>.indexeddb.leveldb` and `.blob`) from a profile into a
 * throwaway user-data-dir, so it can be read in a browser that has a debug port while the source browser
 * keeps running. The leveldb `LOCK` file is skipped. Refuses to overwrite an existing target.
 * Pure filesystem: the caller launches the browser and dumps with `dumpIndexedDb`.
 */
export async function copyOriginIndexedDb(options: CopyOriginIndexedDbOptions): Promise<CopyOriginIndexedDbResult> {
    const stopProfile = prof.start("storage.copy-indexeddb");
    try {
        const key = originStorageKey(options.origin);
        const sourceRoot = join(options.profileDir, "IndexedDB");
        const targetRoot = join(options.userDataDir, options.profileName ?? "Default", "IndexedDB");
        const names = [`${key}.indexeddb.leveldb`, `${key}.indexeddb.blob`];
        const present: string[] = [];
        for (const name of names) {
            if (await exists(join(sourceRoot, name))) {
                present.push(name);
            }
        }

        if (!present.includes(names[0])) {
            throw new Error(`no IndexedDB for ${options.origin} in ${sourceRoot} (expected ${names[0]})`);
        }

        await mkdir(targetRoot, { recursive: true });
        const copied: CopiedFolder[] = [];
        for (const name of present) {
            const from = join(sourceRoot, name);
            const to = join(targetRoot, name);
            if (await exists(to)) {
                throw new Error(`${to} already exists; pick a new user-data-dir`);
            }

            await cp(from, to, {
                recursive: true,
                errorOnExist: true,
                force: false,
                filter: (src) => basename(src) !== "LOCK",
            });
            copied.push({ from, to, ...(await folderStats(to)) });
        }

        return { copied, onDiskBytes: copied.reduce((sum, folder) => sum + folder.bytes, 0), origin: options.origin };
    } finally {
        stopProfile();
    }
}

/**
 * Clears named localStorage/sessionStorage keys in every new document before the app's scripts run,
 * so state that survives reloads (a sampling decision, a cached flag) cannot leak from one run into the next.
 */
export function clearStorageBeforeLoad(cdp: CdpLike, args: ClearStorageArgs): Promise<InitScript> {
    return addInitScript(cdp, clearStorageKeys, args);
}

/** A cookie set on `cookieDomain` belongs to `domain`: the same host, a parent domain it is sent to, or a subdomain. */
function cookieBelongsTo(cookieDomain: string, domain: string): boolean {
    const cookie = cookieDomain.replace(/^\./, "").toLowerCase();
    const wanted = domain.replace(/^\./, "").toLowerCase();
    return cookie === wanted || wanted.endsWith(`.${cookie}`) || cookie.endsWith(`.${wanted}`);
}

/**
 * Deletes cookies whose name is listed. With `domain` (a host such as `app.example.com`), only the cookies of that
 * host, its parent domains and its subdomains go; a cookie of the same name on another site stays. Without it, every
 * matching cookie in the browser profile goes. Returns how many were deleted.
 */
export async function deleteCookies(cdp: CdpLike, options: { names: string[]; domain?: string }): Promise<number> {
    const stopProfile = prof.start("storage.delete-cookies");
    try {
        const reply = (await cdp.send("Network.getAllCookies")) as {
            cookies?: Array<{ name: string; domain: string; path: string }>;
        };
        const doomed = (reply.cookies ?? []).filter(
            (cookie) =>
                options.names.includes(cookie.name) &&
                (options.domain === undefined || cookieBelongsTo(cookie.domain, options.domain))
        );
        for (const cookie of doomed) {
            await cdp.send("Network.deleteCookies", { name: cookie.name, domain: cookie.domain, path: cookie.path });
        }

        return doomed.length;
    } finally {
        stopProfile();
    }
}
