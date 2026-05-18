import { wipeAllTestIndexes } from "./storage";

/**
 * Test preload — runs once before any test file is imported in each worker.
 * Wipes test/bench indexes from the user's homedir that are older than 2
 * minutes, so crashed prior runs can never accumulate stale state.
 *
 * The 120 000 ms age gate prevents this preload from deleting indexes that
 * are being actively used by a concurrently-running parallel worker. A live
 * index will have been modified (mtime) in the last few seconds; a stale
 * index from a crashed prior run will be minutes or hours old.
 */
wipeAllTestIndexes(120_000);
