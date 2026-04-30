import { wipeAllTestIndexes } from "./storage";

/**
 * Test preload — runs once before any test file is imported. Wipes every
 * known test/bench index from the user's homedir so a crashed prior run can
 * never accumulate. Listed in bunfig.toml under [test].preload.
 */
wipeAllTestIndexes();
