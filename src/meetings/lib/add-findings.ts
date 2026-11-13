import { SafeJSON } from "@genesiscz/utils/json";
import type { MeetingsConfig } from "@genesiscz/utils/meetings/config";
import type { MeetingItem, MeetingRecord } from "@genesiscz/utils/meetings/record";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { type Finding, findingItems, findingProblems } from "./findings";
import { diagnoseTermAddress } from "./term-address";
import { checkAnchors, correctTranscript } from "./transcript-corrections";

/**
 * The items a list of findings adds, each join and line-bound term anchored to its transcript line when a transcript
 * is at hand. Shared by `items add` and the REPL's `meeting.items.add`; a finding the record refuses throws.
 */
export function prepareFindings(options: {
    findings: Finding[];
    items: MeetingItem[];
    transcript?: TranscriptEntry[];
    allowDuplicates?: boolean;
    /** Store a line-scoped term even when its address cannot apply. */
    force?: boolean;
}): { added: MeetingItem[]; duplicates: MeetingItem[]; warnings: string[] } {
    const problems = findingProblems(options.findings, options.items);

    if (problems.length > 0) {
        throw new Error(problems.join("; "));
    }

    const added = findingItems(options.findings, options.items, new Date().toISOString());
    const anchors = options.transcript ? checkAnchors(added, options.transcript) : undefined;
    const diagnostics = options.transcript
        ? added.flatMap((item) =>
              item.kind === "term" ? (diagnoseTermAddress({ item, transcript: options.transcript! }) ?? []) : []
          )
        : [];
    const invalid = diagnostics.filter((entry) => entry.kind !== "found");

    if (!options.force && invalid.length > 0) {
        throw new Error(
            invalid.map((entry) => `${entry.item}: ${entry.message}; correct the anchor or pass --force`).join("; ")
        );
    }

    for (const item of added) {
        const line = anchors?.addresses.get(item.id);

        if (line !== undefined) {
            item.evidence = { ...item.evidence, transcriptLine: line };
        }
        if (item.kind === "question" && options.transcript) {
            const words = options.transcript
                .filter(
                    (entry) =>
                        entry.startSec !== undefined && entry.startSec >= item.fromSec && entry.startSec <= item.toSec
                )
                .reduce((sum, entry) => sum + entry.text.split(/\s+/).filter(Boolean).length, 0);
            const shared = [...options.items, ...added].filter(
                (candidate) =>
                    candidate.kind === "speaker-range" &&
                    candidate.status === "suggested" &&
                    (item.signature
                        ? candidate.evidence?.signature === item.signature
                        : candidate.speaker && item.choices.includes(candidate.speaker))
            );
            const reach = Math.max(1, shared.length);
            item.priority = (1 - (item.confidence ?? 0.5)) * Math.max(1, words) * reach;
            const targets = [...options.items, ...added].filter(
                (target) => target.kind === "speaker-range" && item.decides.includes(target.id)
            );
            item.evidence = {
                ...item.evidence,
                words,
                reach,
                labels: [
                    ...new Set(targets.flatMap((target) => (target.kind === "speaker-range" ? [target.label] : []))),
                ],
            };
            if (item.signature) {
                for (const target of targets) {
                    target.evidence = { ...target.evidence, signature: item.signature, choices: item.choices };
                }
            }
        }
    }

    const retained = new Map<string, MeetingItem>();
    const accepted: MeetingItem[] = [];
    const duplicates = new Map<string, MeetingItem>();
    const remapped = new Map<string, string>();

    for (const item of options.items.filter((item) => item.status === "suggested")) {
        const key = findingKey(item);
        if (!retained.has(key)) {
            retained.set(key, item);
        }
    }

    // Resolve range refs before comparing questions, including a question before its range in the batch.
    for (const item of [
        ...added.filter((item) => item.kind !== "question"),
        ...added.filter((item) => item.kind === "question"),
    ]) {
        if (item.kind === "question") {
            item.decides = item.decides.map((id) => remapped.get(id) ?? id);
        }

        const key = findingKey(item);
        const existing = options.allowDuplicates ? undefined : retained.get(key);
        if (existing) {
            remapped.set(item.id, existing.id);
            duplicates.set(item.id, existing);
        } else {
            retained.set(key, item);
            accepted.push(item);
        }
    }

    const order = new Map(added.map((item, index) => [item.id, index]));
    accepted.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    const orderedDuplicates = added.flatMap((item) => duplicates.get(item.id) ?? []);
    return {
        added: accepted,
        duplicates: orderedDuplicates,
        warnings: [
            ...(anchors?.warnings.filter(
                (warning) => !diagnostics.some((entry) => warning.startsWith(`${entry.item}:`))
            ) ?? []),
            ...invalid.map((entry) => `${entry.item}: ${entry.message}`),
            ...orderedDuplicates.map(
                (item) => `Already open: ${item.id} (${item.kind}); nothing added for this finding.`
            ),
        ],
    };
}

/** Lifecycle, provenance and generated ids do not distinguish the content of an open finding. */
function findingKey(item: MeetingItem): string {
    const fields = [
        "kind",
        "confidence",
        "label",
        "fromSec",
        "toSec",
        "speaker",
        "candidates",
        "meaningless",
        "atSec",
        "heard",
        "proposed",
        "scope",
        "meaning",
        "quote",
        "joined",
        "about",
        "question",
        "choices",
        "decides",
    ];
    const content = Object.fromEntries(Object.entries(item).filter(([key]) => fields.includes(key)));
    content.evidence = { reason: item.evidence?.reason, transcriptLine: item.evidence?.transcriptLine };
    const stable = (value: unknown): unknown => {
        if (Array.isArray(value)) {
            return value.map(stable);
        }
        if (value && typeof value === "object") {
            return Object.fromEntries(
                Object.entries(value)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([key, entry]) => [key, stable(entry)])
            );
        }
        return value;
    };
    return SafeJSON.stringify(stable(content));
}

/** A pure preview through the same corrections and line-address pipeline used to render the transcript. */
export function planFindings(options: {
    findings: Finding[];
    record: MeetingRecord;
    transcript: TranscriptEntry[];
    config: MeetingsConfig;
}) {
    const prepared = prepareFindings({ ...options, items: options.record.items, allowDuplicates: true, force: true });
    return {
        warnings: prepared.warnings,
        findings: prepared.added.map((item, index) => {
            const result = correctTranscript({
                record: {
                    ...options.record,
                    items: [
                        item,
                        ...(item.kind === "question"
                            ? [...prepared.added, ...options.record.items].filter((target) =>
                                  item.decides.includes(target.id)
                              )
                            : []),
                    ],
                    speakers: { labels: {} },
                },
                transcript: options.transcript,
                config: options.config,
                format: "txt",
                dictionary: false,
                include: [item.id],
            });
            const outcome = result.outcomes.find((outcome) => outcome.item === item.id);
            const indexes =
                outcome && "lines" in outcome
                    ? outcome.lines.map((line) => line.index)
                    : item.kind === "question"
                      ? result.entries.flatMap((entry, line) =>
                            entry.text !== options.transcript[line]?.text ||
                            entry.speaker !== options.transcript[line]?.speaker
                                ? [line]
                                : []
                        )
                      : [];
            return {
                finding: index + 1,
                kind: item.kind,
                status: outcome?.status ?? (indexes.length ? "applied" : "not-found"),
                lines: [...new Set(indexes)].map((index) => ({
                    index,
                    firstWords: options.transcript[index]!.text.trim().split(/\s+/).slice(0, 8).join(" "),
                })),
                ...(outcome && "reason" in outcome ? { reason: outcome.reason } : {}),
            };
        }),
    };
}
