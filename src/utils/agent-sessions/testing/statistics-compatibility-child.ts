import { appendFileSync } from "node:fs";
import {
    getConversationStatsWithCache,
    getQuickStatsFromCache,
    getStatsForDateRange,
} from "../../../claude/lib/history/search";
import { env } from "../../env";
import { SafeJSON } from "../../json";
import { HistoryDatabase } from "../database";

const source = env.get("HISTORY_STATISTICS_FIXTURE_SOURCE");
if (!source) {
    throw new Error("HISTORY_STATISTICS_FIXTURE_SOURCE is required");
}

const initial = await getConversationStatsWithCache({ forceRefresh: true });
const quickAfterInitial = getQuickStatsFromCache();
const ranged = await getStatsForDateRange({ from: "2026-08-15", to: "2026-08-15" });
const quickAfterRange = getQuickStatsFromCache();
const repeated = await getConversationStatsWithCache({ forceRefresh: true });
const quickAfterRepeat = getQuickStatsFromCache();

appendFileSync(
    source,
    `${SafeJSON.stringify(
        {
            type: "user",
            sessionId: "11111111-2222-4333-8444-555555555555",
            cwd: "/projects/shop",
            gitBranch: "fixture-main",
            timestamp: "2026-08-14T11:00:00.000Z",
            message: { content: "second dated message" },
        },
        { strict: true }
    )}\n`
);

const modified = await getConversationStatsWithCache({ forceRefresh: true });
const quickAfterModified = getQuickStatsFromCache();
HistoryDatabase.closeInstance();

process.stdout.write(
    SafeJSON.stringify(
        {
            initial,
            quickAfterInitial,
            ranged,
            quickAfterRange,
            repeated,
            quickAfterRepeat,
            modified,
            quickAfterModified,
        },
        { strict: true }
    )
);
