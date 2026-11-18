import { SafeJSON } from "@genesiscz/utils/json";
import { type MeetingsConfig, meetingsConfigSchema, resolveDictionary } from "@genesiscz/utils/meetings/config";
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
    name: string,
    path: string,
    title: string,
    meaning: string,
    min = 0,
    max: number | null = 1,
    step = 0.01
): Threshold {
    return { name, path: `global.${path}`, title, meaning, min, ...(max === null ? {} : { max }), step };
}

const catalog = [
    threshold(
        "term.applyAbove",
        "suggest.terms.applyAbove",
        "Apply proposed terms",
        "Use a suggested term at or above this confidence when the transcript includes suggestions."
    ),
    threshold(
        "fuzzy.suggest",
        "suggest.terms.fuzzy.suggest",
        "Suggest dictionary matches",
        "Propose words that resemble a dictionary spelling at or above this score."
    ),
    threshold(
        "fuzzy.apply",
        "suggest.terms.fuzzy.apply",
        "Replace dictionary matches",
        "Replace a matching word directly at or above this score."
    ),
    threshold(
        "term.phonetic",
        "suggest.terms.phonetic",
        "Suggest similar phrases",
        "Propose a vocabulary term when a spoken phrase sounds this close."
    ),
    threshold(
        "term.unknownCandidate",
        "suggest.terms.unknownCandidate",
        "Suggest a spelling for an unknown word",
        "Give an unfamiliar word a proposed spelling when a candidate reaches this score."
    ),
    threshold(
        "applyAbove",
        "suggest.applyAbove",
        "Apply speaker suggestions",
        "Use suggested speaker names and other non-term corrections at or above this confidence."
    ),
    threshold(
        "listenBelow",
        "suggest.listenBelow",
        "Ask to listen",
        "Consider asking about a term or speaker below this confidence."
    ),
    threshold(
        "words.minOccurrences",
        "suggest.words.minOccurrences",
        "Word repetitions",
        "Ask about an unfamiliar word after this many occurrences.",
        2,
        50,
        1
    ),
    threshold(
        "questionCap",
        "suggest.questionCap",
        "Question limit",
        "Limit the total number of open rule questions per meeting.",
        1,
        500,
        1
    ),
    threshold(
        "minPriority",
        "playback.listen.minPriority",
        "Minimum question priority",
        "Keep ordinary listening questions at or above this priority.",
        0,
        null
    ),
    threshold(
        "longStretchWords",
        "suggest.longStretchWords",
        "Words in an unclear stretch",
        "Ask about a continuous stretch of uncertain speech once it contains this many words.",
        1,
        null,
        1
    ),
    threshold(
        "leaveSilenceMinutes",
        "suggest.leaveSilenceMinutes",
        "Minutes before an inferred departure",
        "Require this much observed silence before inferring a participant left.",
        1,
        120,
        0.1
    ),
    threshold(
        "voice.gate.score",
        "speakerLabels.voice.gate.score",
        "Voice match score",
        "A voice must match a confirmed sample at least this closely to name its speaker."
    ),
    threshold(
        "voice.gate.margin",
        "speakerLabels.voice.gate.margin",
        "Lead over the next voice",
        "Require this difference between the two best voice scores."
    ),
    threshold(
        "voice.gate.loneScore",
        "speakerLabels.voice.gate.loneScore",
        "Single sampled speaker",
        "Require this score when only one participant has a sample."
    ),
    threshold(
        "voice.gate.unsampledScore",
        "speakerLabels.voice.gate.unsampledScore",
        "Participant without a sample",
        "Require this score when someone attending has no sample."
    ),
    threshold(
        "voice.gate.strangerScore",
        "speakerLabels.voice.gate.strangerScore",
        "Different voice on a seat",
        "Question the seat owner's name when the voice scores below this value."
    ),
    threshold(
        "voice.minSeconds",
        "speakerLabels.voice.minSeconds",
        "Minimum voice duration",
        "Compare a line to voice samples only when it lasts this many seconds.",
        0,
        60,
        0.1
    ),
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
            (row.step === 1 && !Number.isInteger(value))
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

function snapshot(record: MeetingRecord, config: MeetingsConfig, transcript: TranscriptEntry[]) {
    const corrected = correctTranscript({ record, config, transcript, format: "json", withSuggested: true });
    const outcomes = new Map(corrected.outcomes.map((outcome) => [outcome.item, outcome]));
    const keys = new Map(record.items.map((item) => [item.id, itemKey(item)]));
    const byTime = new Map<number, TranscriptEntry>();
    for (const line of transcript) {
        if (line.startSec !== undefined && !byTime.has(line.startSec)) {
            byTime.set(line.startSec, line);
        }
    }
    const rows = new Map<string, Located>();
    for (const item of record.items) {
        const index = lineOf(item);
        const atSec = "fromSec" in item ? item.fromSec : item.atSec;
        const line = index !== undefined ? transcript[index] : atSec !== undefined ? byTime.get(atSec) : undefined;
        const kind =
            item.kind === "question" ? `${item.about} question` : item.kind === "term" ? "term proposal" : item.kind;
        const outcome = outcomes.get(item.id);
        // New suggestion IDs depend on how many earlier rules fired. Compare questions by what they decide.
        const key =
            item.kind === "question"
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
        rows.set(key, {
            kind,
            atSec: line?.startSec ?? atSec,
            text: line?.text ?? itemWhat(item),
            state: { status: outcome?.status ?? item.status, confidence: item.confidence, description: itemWhat(item) },
            reason: outcome && "reason" in outcome ? outcome.reason : meetingRuleNames(item.rules).join(" "),
        });
    }
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
    return {
        thresholds,
        ...thresholdDifferences(
            snapshot(run.before, config, run.transcript),
            snapshot(run.after, draft, run.transcript),
            changed.join(", ")
        ),
        warnings: run.warnings,
    };
}
