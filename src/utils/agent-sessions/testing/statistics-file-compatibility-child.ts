import { computeFileStats, processFileForCache } from "../../../claude/lib/history/search";
import { env } from "../../env";
import { SafeJSON } from "../../json";
import { HistoryDatabase } from "../database";

const source = env.get("HISTORY_STATISTICS_FIXTURE_SOURCE");
if (!source) {
    throw new Error("HISTORY_STATISTICS_FIXTURE_SOURCE is required");
}

const computed = await computeFileStats(source);
const first = await processFileForCache(source);
const second = await processFileForCache(source);
// Report what actually failed: a bare boolean passed for any error at all, including one
// thrown before the missing file was ever reached.
let missingRejected = "";
try {
    await computeFileStats(`${source}.missing`);
} catch (error) {
    missingRejected = error instanceof Error ? error.message : String(error);
}
HistoryDatabase.closeInstance();
process.stdout.write(SafeJSON.stringify({ computed, first, second, missingRejected }, { strict: true }));
