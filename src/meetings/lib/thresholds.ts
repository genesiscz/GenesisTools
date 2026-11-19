import { SafeJSON } from "@genesiscz/utils/json";
import {
    MEETINGS_CONFIG_VERSION,
    type MeetingsConfig,
    meetingsConfigSchema,
    resolveDictionary,
} from "@genesiscz/utils/meetings/config";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { meetingRuleNames } from "@genesiscz/utils/meetings/rules";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { configValueAt, setAt } from "./config-edit";
import { itemWhat } from "./item-text";
import type { OpenedMeeting } from "./opened-meeting";
import { itemKey } from "./suggest";
import type { ThresholdChange, ThresholdResult } from "./threshold-schema";
import { correctTranscript, lineOf } from "./transcript-corrections";

interface Threshold {
    name: string;
    path: string;
    title: string;
    meaning: string;
    min: number;
    max?: number;
    step: number;
}

function threshold(
    options: Omit<Threshold, "min" | "max" | "step"> & {
        min?: number;
        max?: number | null;
        step?: number;
    }
): Threshold {
    const { path, min = 0, max = 1, step = 0.01, ...labels } = options;
    return { ...labels, path: `global.${path}`, min, ...(max === null ? {} : { max }), step };
}

const catalog = [
    threshold({
        name: "term.applyAbove",
        path: "suggest.terms.applyAbove",
        title: "Apply proposed terms",
        meaning: "Use a suggested term at or above this confidence when the transcript includes suggestions.",
    }),
    threshold({
        name: "fuzzy.suggest",
        path: "suggest.terms.fuzzy.suggest",
        title: "Suggest dictionary matches",
        meaning: "Propose words that resemble a dictionary spelling at or above this score.",
    }),
    threshold({
        name: "fuzzy.apply",
        path: "suggest.terms.fuzzy.apply",
        title: "Replace dictionary matches",
        meaning: "Replace a matching word directly at or above this score.",
    }),
    threshold({
        name: "term.phonetic",
        path: "suggest.terms.phonetic",
        title: "Suggest similar phrases",
        meaning: "Propose a vocabulary term when a spoken phrase sounds this close.",
    }),
    threshold({
        name: "term.unknownCandidate",
        path: "suggest.terms.unknownCandidate",
        title: "Suggest a spelling for an unknown word",
        meaning: "Give an unfamiliar word a proposed spelling when a candidate reaches this score.",
    }),
    threshold({
        name: "applyAbove",
        path: "suggest.applyAbove",
        title: "Apply speaker suggestions",
        meaning: "Use suggested speaker names and other non-term corrections at or above this confidence.",
    }),
    threshold({
        name: "listenBelow",
        path: "suggest.listenBelow",
        title: "Ask to listen",
        meaning: "Consider asking about a term or speaker below this confidence.",
    }),
    threshold({
        name: "words.minOccurrences",
        path: "suggest.words.minOccurrences",
        title: "Word repetitions",
        meaning: "Ask about an unfamiliar word after this many occurrences.",
        min: 2,
        max: 50,
        step: 1,
    }),
    threshold({
        name: "questionCap",
        path: "suggest.questionCap",
        title: "Question budget",
        meaning: "Budget for ordinary rule questions. Voice exclusions can exceed it.",
        min: 1,
        max: 500,
        step: 1,
    }),
    threshold({
        name: "minPriority",
        path: "playback.listen.minPriority",
        title: "Minimum question priority",
        meaning: "Keep ordinary listening questions at or above this priority.",
        min: 0,
        max: null,
    }),
    threshold({
        name: "longStretchWords",
        path: "suggest.longStretchWords",
        title: "Words in an unclear stretch",
        meaning: "Ask about a continuous stretch of uncertain speech once it contains this many words.",
        min: 1,
        max: null,
        step: 1,
    }),
    threshold({
        name: "leaveSilenceMinutes",
        path: "suggest.leaveSilenceMinutes",
        title: "Minutes before an inferred departure",
        meaning: "Require this much observed silence before inferring a participant left.",
        min: 1,
        max: 120,
        step: 0.1,
    }),
    threshold({
        name: "voice.gate.score",
        path: "speakerLabels.voice.gate.score",
        title: "Voice match score",
        meaning: "A voice must match a confirmed sample at least this closely to name its speaker.",
    }),
    threshold({
        name: "voice.gate.margin",
        path: "speakerLabels.voice.gate.margin",
        title: "Lead over the next voice",
        meaning: "Require this difference between the two best voice scores.",
    }),
    threshold({
        name: "voice.gate.loneScore",
        path: "speakerLabels.voice.gate.loneScore",
        title: "Single sampled speaker",
        meaning: "Require this score when only one participant has a sample.",
    }),
    threshold({
        name: "voice.gate.unsampledScore",
        path: "speakerLabels.voice.gate.unsampledScore",
        title: "Participant without a sample",
        meaning: "Require this score when someone attending has no sample.",
    }),
    threshold({
        name: "voice.gate.strangerScore",
        path: "speakerLabels.voice.gate.strangerScore",
        title: "Different voice on a seat",
        meaning: "Question the seat owner's name when the voice scores below this value.",
    }),
    threshold({
        name: "voice.minSeconds",
        path: "speakerLabels.voice.minSeconds",
        title: "Minimum voice duration",
        meaning: "Compare a line to voice samples only when it lasts this many seconds.",
        min: 0,
        max: 60,
        step: 0.1,
    }),
];
const defaults = meetingsConfigSchema.parse({});
const byName = new Map(catalog.map((row) => [row.name, row]));

function numeric(config: MeetingsConfig, path: string): number {
    const value = configValueAt(config, path.split("."));
    if (typeof value !== "number") {
        throw new Error(`Missing numeric Meetings setting ${path}`);
    }
    return value;
}

export function thresholdEdits(values: Record<string, number>) {
    return Object.entries(values).map(([name, value]) => {
        const row = byName.get(name);
        if (!row) {
            throw new Error(
                `Unknown threshold "${name}". Choose one of: ${catalog.map((option) => option.name).join(", ")}`
            );
        }
        if (
            !Number.isFinite(value) ||
            value < row.min ||
            (row.max !== undefined && value > row.max) ||
            (row.step === 1 && !Number.isSafeInteger(value))
        ) {
            throw new Error(
                `${name} needs ${row.step === 1 ? "an integer" : "a number"} from ${row.min}${row.max === undefined ? " upwards" : ` to ${row.max}`}`
            );
        }
        return { path: row.path, value };
    });
}

function describe(config: MeetingsConfig, raw: unknown, record?: MeetingRecord): ThresholdResult["thresholds"] {
    const project = record?.project;
    const dictionary = resolveDictionary(config, { project, meeting: record?.dictionary });
    return catalog.map((row) => {
        const globalValue = numeric(config, row.path);
        let value = globalValue;
        let source = configValueAt(raw, row.path.split(".")) === undefined ? "default" : row.path;
        const version = configValueAt(raw, ["version"]);
        if (
            row.name === "term.applyAbove" &&
            source === "default" &&
            (typeof version !== "number" || version < MEETINGS_CONFIG_VERSION) &&
            typeof configValueAt(raw, ["global", "suggest", "applyAbove"]) === "number"
        ) {
            source = "global.suggest.applyAbove (migrated)";
        }
        if (row.name === "fuzzy.apply" || row.name === "fuzzy.suggest") {
            const key = row.name === "fuzzy.apply" ? "apply" : "suggest";
            value = dictionary.fuzzy?.[key] ?? globalValue;
            if (record?.dictionary?.fuzzy?.[key] !== undefined) {
                source = `meeting dictionary.fuzzy.${key}`;
            } else if (project && config.projects[project]?.dictionary?.fuzzy?.[key] !== undefined) {
                source = `project ${project} dictionary.fuzzy.${key}`;
            } else if (config.global.dictionary.fuzzy?.[key] !== undefined) {
                source = `global.dictionary.fuzzy.${key}`;
            }
        }
        return { ...row, defaultValue: numeric(defaults, row.path), globalValue, value, source };
    });
}

type State = NonNullable<ThresholdChange["before"]>;
type Located = { kind: string; state: State; atSec?: number; text: string; reason: string };

function snapshot(options: {
    stored: MeetingRecord;
    regenerated: MeetingRecord;
    retainedIds: ReadonlySet<string>;
    regeneratedRetainedIds: ReadonlySet<string>;
    config: MeetingsConfig;
    transcript: TranscriptEntry[];
}) {
    const { stored, regenerated, retainedIds, regeneratedRetainedIds, config, transcript } = options;
    const render = (record: MeetingRecord) =>
        correctTranscript({ record, config, transcript, format: "json", withSuggested: true });
    const corrected = render(stored);
    const byTime = new Map<number, TranscriptEntry>();
    for (const line of transcript) {
        if (line.startSec !== undefined && !byTime.has(line.startSec)) {
            byTime.set(line.startSec, line);
        }
    }
    const rows = new Map<string, Located>();

    const items = (
        record: MeetingRecord,
        outcomes: ReturnType<typeof render>["outcomes"],
        regeneratedItems: boolean
    ) => {
        const byId = new Map(outcomes.map((outcome) => [outcome.item, outcome]));
        const keys = new Map(
            record.items.map((item) => [item.id, retainedIds.has(item.id) ? `saved:${item.id}` : itemKey(item)])
        );
        for (const item of record.items) {
            const retained = retainedIds.has(item.id);
            if (regeneratedItems && retained && !regeneratedRetainedIds.has(item.id)) {
                continue;
            }
            const index = lineOf(item);
            const atSec = "fromSec" in item ? item.fromSec : item.atSec;
            const line = index !== undefined ? transcript[index] : atSec !== undefined ? byTime.get(atSec) : undefined;
            const kind =
                item.kind === "question"
                    ? `${item.about} question`
                    : item.kind === "term"
                      ? "term proposal"
                      : item.kind;
            const outcome = byId.get(item.id);
            // New suggestion IDs depend on how many earlier rules fired. Compare questions by what they decide.
            const semanticKey = retained
                ? `saved:${item.id}`
                : item.kind === "question"
                  ? SafeJSON.stringify([
                        item.kind,
                        item.group,
                        item.about,
                        item.fromSec,
                        item.toSec,
                        item.heard,
                        item.decides.map((id) => keys.get(id) ?? id).sort(),
                    ])
                  : keys.get(item.id)!;
            const what = itemWhat(item);
            rows.set(regeneratedItems ? `regenerated:${semanticKey}` : `saved:${item.id}`, {
                kind: regeneratedItems ? `regenerated ${kind}` : kind,
                atSec: line?.startSec ?? atSec,
                text: line?.text ?? what,
                state: { status: outcome?.status ?? item.status, confidence: item.confidence, description: what },
                reason: outcome && "reason" in outcome ? outcome.reason : meetingRuleNames(item.rules).join(" "),
            });
        }
    };
    items(stored, corrected.outcomes, false);
    items(regenerated, render(regenerated).outcomes, true);
    // Direct dictionary replacements have no item ID. Compare the rendered lines too, including every occurrence.
    const repeats = new Map<string, number>();
    for (const line of corrected.entries) {
        const address = SafeJSON.stringify([line.id, line.startSec]);
        const occurrence = repeats.get(address) ?? 0;
        repeats.set(address, occurrence + 1);
        const key = `transcript:${address}:${occurrence}`;
        rows.set(key, {
            kind: "transcript line",
            atSec: line.startSec,
            text: line.text,
            state: {
                status: line.band ?? "transcript",
                confidence: line.confidence,
                description: `${line.speaker}: ${line.text}`,
            },
            reason: "The transcript includes suggestions and the effective dictionary.",
        });
    }
    return rows;
}

function thresholdDifferences(before: Map<string, Located>, after: Map<string, Located>, settings: string) {
    const changes: ThresholdChange[] = [];
    const counts = new Map<string, ThresholdResult["counts"][number]>();
    for (const key of new Set([...before.keys(), ...after.keys()])) {
        const old = before.get(key);
        const next = after.get(key);
        if (old && next && Bun.deepEquals(old.state, next.state)) {
            continue;
        }
        const row = next ?? old!;
        const change = !old ? "added" : !next ? "removed" : "changed";
        changes.push({
            key,
            kind: row.kind,
            change,
            atSec: row.atSec,
            text: old?.text ?? row.text,
            before: old?.state,
            after: next?.state,
            reason: [settings, row.reason].filter(Boolean).join(". "),
        });
        const count = counts.get(row.kind) ?? { kind: row.kind, added: 0, removed: 0, changed: 0 };
        count[change]++;
        counts.set(row.kind, count);
    }
    changes.sort((a, b) => (a.atSec ?? Infinity) - (b.atSec ?? Infinity) || a.key.localeCompare(b.key));
    return { changes, counts: [...counts.values()] };
}

export async function meetingThresholds(options: {
    config: MeetingsConfig;
    raw: unknown;
    opened?: OpenedMeeting;
    values: Record<string, number>;
    signal?: AbortSignal;
}): Promise<ThresholdResult> {
    const { config, raw, opened, values, signal } = options;
    const thresholds = describe(config, raw, opened?.record);
    const edits = thresholdEdits(values);
    const empty = { thresholds, changes: [], counts: [], warnings: [] };
    if (!edits.length) {
        return empty;
    }
    if (!opened) {
        throw new Error("Choose a meeting to preview threshold changes.");
    }
    const draft = structuredClone(config);
    for (const { path, value } of edits) {
        setAt(draft, path.split("."), value);
    }
    const changed = describe(draft, raw, opened.record).flatMap((row, index) =>
        row.value === thresholds[index]!.value ? [] : [`${row.title} ${thresholds[index]!.value} → ${row.value}`]
    );
    if (!changed.length) {
        return empty;
    }
    const { previewSuggestionRuns } = await import("./suggest-run");
    const run = await previewSuggestionRuns(opened, config, draft, signal);
    signal?.throwIfAborted();
    const beforeStatuses = new Map(run.before.items.map((item) => [item.id, item.status]));
    const regeneratedRetainedIds = new Set(
        run.after.items
            .filter((item) => run.retainedIds.has(item.id) && item.status !== beforeStatuses.get(item.id))
            .map((item) => item.id)
    );
    return {
        thresholds,
        ...thresholdDifferences(
            snapshot({
                stored: opened.record,
                regenerated: run.before,
                retainedIds: run.retainedIds,
                regeneratedRetainedIds,
                config,
                transcript: run.transcript,
            }),
            snapshot({
                stored: opened.record,
                regenerated: run.after,
                retainedIds: run.retainedIds,
                regeneratedRetainedIds,
                config: draft,
                transcript: run.transcript,
            }),
            changed.join(", ")
        ),
        warnings: run.warnings,
    };
}
