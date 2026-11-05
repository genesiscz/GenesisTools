import type { MeetingItem } from "@genesiscz/utils/meetings/record";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { type Finding, findingItems, findingProblems } from "./findings";
import { checkAnchors } from "./transcript-corrections";

export function prepareFindings(options: {
    findings: Finding[];
    items: MeetingItem[];
    transcript?: TranscriptEntry[];
}): { added: MeetingItem[]; warnings: string[] } {
    const problems = findingProblems(options.findings, options.items);
    if (problems.length > 0) {
        throw new Error(problems.join("; "));
    }

    const added = findingItems(options.findings, options.items, new Date().toISOString());
    const anchors = options.transcript ? checkAnchors(added, options.transcript) : undefined;
    for (const item of added) {
        const line = anchors?.addresses.get(item.id);
        if (line !== undefined) {
            item.evidence = { ...item.evidence, transcriptLine: line };
        }
    }

    return { added, warnings: anchors?.warnings ?? [] };
}
