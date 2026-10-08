import { relative, sep } from "node:path";
import { listBigFiles } from "@app/du/lib/engine";
import { logger } from "@genesiscz/utils/logger";
import { apfsProbe, type BlockProbe } from "./freeable";
import { type ResolvedKeepPartner, resolveKeepPartners, spawnCacheCommand } from "./keep-partners";
import { clonesProfile } from "./profile";

const log = logger.child({ component: "clones:store-report" });

export interface StoreEntry {
    /** `react-native-skia-apple-ios@150.0.0@@<registry>@@@1`, or `@scope/name@…`. */
    entry: string;
    files: number;
    /** Private bytes of the entry's listed files: what deleting it would free. */
    privateBytes: number;
}

export interface StoreReport {
    store: ResolvedKeepPartner;
    minBytes: number;
    filesListed: number;
    entries: StoreEntry[];
    totalPrivate: number;
}

/** The bun cache entry a file belongs to: the first path segment under the
 *  cache root, two for a scoped package. Null for a file at the root itself. */
export function bunEntryOf(root: string, file: string): string | null {
    const parts = relative(root, file).split(sep);
    if (parts.length < 2 || parts[0] === "..") {
        return null;
    }

    if (parts[0].startsWith("@")) {
        return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : null;
    }

    return parts[0];
}

/** Entries whose every listed file is fully private: nothing else clones them,
 *  so no install tree uses those bytes. A file the probe cannot read keeps its
 *  entry out of the report rather than in it. */
export function unreferencedEntries({
    root,
    files,
    probe = apfsProbe,
}: {
    root: string;
    files: string[];
    probe?: BlockProbe;
}): StoreEntry[] {
    const byEntry = new Map<string, { files: number; privateBytes: number; referenced: boolean }>();
    for (const file of files) {
        const entry = bunEntryOf(root, file);
        if (entry === null) {
            continue;
        }

        const acc = byEntry.get(entry) ?? { files: 0, privateBytes: 0, referenced: false };
        byEntry.set(entry, acc);
        const allocated = probe.allocatedBytes(file);
        const priv = probe.privateBytes(file);
        acc.files += 1;
        if (allocated === null || priv === null || allocated === 0 || priv < allocated) {
            acc.referenced = true;
            continue;
        }

        acc.privateBytes += priv;
    }

    return [...byEntry.entries()]
        .filter(([, v]) => !v.referenced)
        .map(([entry, v]) => ({ entry, files: v.files, privateBytes: v.privateBytes }))
        .sort((a, b) => b.privateBytes - a.privateBytes || a.entry.localeCompare(b.entry));
}

/** Report-only scan of the bun cache: entries no install tree clones. Judged by
 *  the files of at least `minBytes`, so a big entry needs only its big files
 *  read. It never deletes anything. */
export async function reportUnreferencedStore({
    minBytes,
    signal,
}: {
    minBytes: number;
    signal?: AbortSignal;
}): Promise<StoreReport | null> {
    const [store] = resolveKeepPartners(["bun"], spawnCacheCommand);
    if (store === undefined) {
        log.warn("bun cache root not found");
        return null;
    }

    const listed = await clonesProfile.measureAsync("store-report.walk", () =>
        listBigFiles({ roots: [store.root], minBytes, ...(signal !== undefined ? { signal } : {}) })
    );
    const entries = clonesProfile.measure("store-report.probe", () =>
        unreferencedEntries({ root: store.root, files: listed.files.map((f) => f.path) })
    );
    const totalPrivate = entries.reduce((s, e) => s + e.privateBytes, 0);
    log.info(
        { root: store.root, minBytes, filesListed: listed.files.length, entries: entries.length, totalPrivate },
        "unreferenced store entries"
    );
    return { store, minBytes, filesListed: listed.files.length, entries, totalPrivate };
}
