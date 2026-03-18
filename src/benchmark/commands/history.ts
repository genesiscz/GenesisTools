import * as p from "@clack/prompts";
import { formatHistory, getHistory } from "@app/benchmark/lib/history";

export async function cmdHistory(suiteName: string, limit: number): Promise<void> {
    const results = await getHistory(suiteName, limit);

    if (results.length === 0) {
        p.log.info(`No history found for suite "${suiteName}".`);
        return;
    }

    p.note(formatHistory(results), `History: ${suiteName} (${results.length} runs)`);
}
