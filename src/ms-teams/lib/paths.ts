import { homedir } from "node:os";
import { join } from "node:path";
import { Storage } from "@genesiscz/utils/storage";

const storage = new Storage("ms-teams");

export function teamsStorage(): Storage {
    return storage;
}

export function cacheDbPath(): string {
    return join(storage.getBaseDir(), "cache.db");
}

export function snapshotDir(): string {
    return join(storage.getBaseDir(), "snapshot");
}

export function venvDir(): string {
    return join(storage.getBaseDir(), "venv");
}

export function venvPython(): string {
    return join(venvDir(), "bin", "python");
}

export function liveIdbDir(): string {
    return join(
        homedir(),
        "Library/Containers/com.microsoft.teams2/Data/Library/Application Support/Microsoft/MSTeams/EBWebView/WV2Profile_tfw/IndexedDB/https_teams.microsoft.com_0.indexeddb.leveldb"
    );
}

export function liveBlobDir(): string {
    return join(
        homedir(),
        "Library/Containers/com.microsoft.teams2/Data/Library/Application Support/Microsoft/MSTeams/EBWebView/WV2Profile_tfw/IndexedDB/https_teams.microsoft.com_0.indexeddb.blob"
    );
}

export function dumpIdbScript(): string {
    return join(import.meta.dir, "../native/dump_idb.py");
}

export function mediaDir(): string {
    return join(storage.getBaseDir(), "media");
}

export function liveDiskCacheDir(): string {
    return join(
        homedir(),
        "Library/Containers/com.microsoft.teams2/Data/Library/Caches/Microsoft/MSTeams/EBWebView/WV2Profile_tfw/Cache/Cache_Data"
    );
}
