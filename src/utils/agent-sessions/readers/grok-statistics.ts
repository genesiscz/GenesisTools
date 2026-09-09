import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createGrokUsageParser } from "@genesiscz/utils/ai/usage/transcripts/grok";
import { SafeJSON } from "@genesiscz/utils/json";
import { asRecord, type JsonValue } from "../source-scan";
import type { HistoryReadOptions, HistoryStatisticsRead, NativeSessionSource } from "../types";
import { readGrokMetadata, scanGrokRecords } from "./grok";
import { createIssueCollector, NativeStatisticsAccumulator, parseUsagePath } from "./native-statistics";

async function currentModel(
    source: NativeSessionSource<"grok">,
    onIssue: (issue: { path: string; message: string }) => void
): Promise<string | undefined> {
    const path = source.metadataPaths.find((candidate) => basename(candidate) === "summary.json");
    if (!path) {
        return;
    }
    try {
        const parsed = asRecord(SafeJSON.parse(await Bun.file(path).text(), { strict: true }) as JsonValue);
        return typeof parsed.current_model_id === "string" ? parsed.current_model_id : undefined;
    } catch {
        onIssue({ path, message: "Usage model summary read failed" });
    }
}
async function usagePathAvailable(
    path: string,
    signal: AbortSignal | undefined,
    onIssue: (issue: { path: string; message: string }) => void
): Promise<boolean> {
    try {
        if ((await stat(path)).isFile()) {
            return true;
        }
        onIssue({ path, message: "Usage source read failed" });
    } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return false;
        }
        onIssue({ path, message: "Usage source read failed" });
    }
    return false;
}

export async function readGrokStatistics(
    source: NativeSessionSource<"grok">,
    options: HistoryReadOptions = {}
): Promise<HistoryStatisticsRead> {
    const collector = createIssueCollector({ onIssue: options.onIssue });
    const metadata = await readGrokMetadata(source, { signal: options.signal, onIssue: collector.add });
    if (!metadata.complete) {
        collector.add({ path: source.filePath, message: "Metadata coverage incomplete" });
    }
    const accumulator = new NativeStatisticsAccumulator({
        project: metadata.metadata?.project ?? source.metadata?.project ?? "",
        isSubagent: metadata.metadata?.isSubagent ?? source.metadata?.isSubagent ?? false,
    });
    try {
        for await (const record of scanGrokRecords(source, { signal: options.signal, onIssue: collector.add })) {
            accumulator.addRecord(record);
        }
    } catch {
        options.signal?.throwIfAborted();
        collector.add({ path: source.filePath, message: "Conversation source read failed" });
    }
    const fallback = join(dirname(source.filePath), "updates.jsonl");
    const statisticsPaths = source.statisticsPaths ?? [fallback];
    if (statisticsPaths.length > 0) {
        const model = await currentModel(source, collector.add);
        for (const path of statisticsPaths) {
            if (!(await usagePathAvailable(path, options.signal, collector.add))) {
                continue;
            }
            await parseUsagePath({
                path,
                parser: createGrokUsageParser({ file: path, state: undefined, currentModel: model }),
                accumulator,
                signal: options.signal,
                onIssue: collector.add,
            });
        }
    }
    return accumulator.result(collector.issues);
}
