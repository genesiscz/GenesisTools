import { createCodexUsageParser } from "@genesiscz/utils/ai/usage/transcripts/codex";
import type { HistoryReadOptions, HistoryStatisticsRead, NativeSessionSource } from "../types";
import { readCodexMetadata, scanCodexRecords } from "./codex";
import { createIssueCollector, NativeStatisticsAccumulator, parseUsagePath } from "./native-statistics";

export async function readCodexStatistics(
    source: NativeSessionSource<"codex">,
    options: HistoryReadOptions = {}
): Promise<HistoryStatisticsRead> {
    const collector = createIssueCollector({ onIssue: options.onIssue });
    const metadata = await readCodexMetadata(source, { signal: options.signal, onIssue: collector.add });
    if (!metadata.complete) {
        collector.add({ path: source.filePath, message: "Metadata coverage incomplete" });
    }
    const accumulator = new NativeStatisticsAccumulator({
        project: metadata.metadata?.project ?? source.metadata?.project ?? "",
        isSubagent: metadata.metadata?.isSubagent ?? source.metadata?.isSubagent ?? false,
        branch: metadata.metadata?.gitBranch ?? source.metadata?.gitBranch,
    });
    try {
        for await (const record of scanCodexRecords(source, { signal: options.signal, onIssue: collector.add })) {
            accumulator.addRecord(record);
        }
    } catch {
        options.signal?.throwIfAborted();
        collector.add({ path: source.filePath, message: "Conversation source read failed" });
    }
    for (const path of source.statisticsPaths ?? [source.filePath]) {
        await parseUsagePath({
            path,
            parser: createCodexUsageParser({ file: path, state: undefined }),
            accumulator,
            signal: options.signal,
            onIssue: collector.add,
        });
    }
    return accumulator.result(collector.issues);
}
