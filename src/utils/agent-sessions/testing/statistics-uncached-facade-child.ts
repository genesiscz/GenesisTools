import { getConversationStats } from "../../../claude/lib/history/search";
import { SafeJSON } from "../../json";
import { HistoryDatabase } from "../database";

const statistics = await getConversationStats();
HistoryDatabase.closeInstance();
process.stdout.write(SafeJSON.stringify(statistics, { strict: true }));
