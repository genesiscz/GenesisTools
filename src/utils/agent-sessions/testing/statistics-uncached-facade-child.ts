import { getConversationStatsWithCache } from "../../../claude/lib/history/search";
import { SafeJSON } from "../../json";
import { HistoryDatabase } from "../database";

const statistics = await getConversationStatsWithCache();
HistoryDatabase.closeInstance();
process.stdout.write(SafeJSON.stringify(statistics, { strict: true }));
