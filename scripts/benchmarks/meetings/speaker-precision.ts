/**
 * Speaker precision on the lines a person decided (leave-truth-out).
 *
 * For each meeting of the store: collect the truth (confirmed speaker ranges a person decided, ranges built on the
 * user's answer, the person's own assignments, and the relayed answers named in --truth), put every truth item back
 * to what it was before the person decided (the decision journal's "before"; an item the decision made is dropped),
 * then render the transcript with the suggested items applied and read what each truth line shows:
 *   plain-correct, plain-wrong, guess-correct, guess-wrong, unclear, unnamed (a source label that is no person), gone.
 * With --pass, the speakers pass runs on the blinded record first, with the meeting's own voice samples left out of
 * the library, so the pass cannot read its answer back.
 *
 * It only runs on a scratch home: GENESIS_TOOLS_HOME must be set and must not be the user's home.
 *
 *   GENESIS_TOOLS_HOME=<scratch> bun scripts/benchmarks/meetings/speaker-precision.ts --out <file.json> \
 *       [--meeting <id>]... [--truth <extras.json>] [--pass] [--set <config.path>=<json>]... [--rows] [--labels]
 *
 * --labels adds to each row what the seat and the voice labeler say about the line on the blinded record (the
 * meeting's own voice samples left out), and the line's channel and speaking-indicator readings.
 * --as-is leaves the truth in: the record is rendered as it is stored (with --pass, after the speakers pass with the
 * whole voice library), to compare what a reader sees before and after a change.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { languageSettings, type MeetingsConfig, MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { rangeStrength, strongestRange } from "@genesiscz/utils/meetings/range-strength";
import {
    isPersonActor,
    JOURNAL_FILE,
    type MeetingItem,
    type MeetingRecord,
    MeetingStore,
} from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { applyCorrections, isUnclearMarker } from "@genesiscz/utils/transcribe/apply";
import { LINE_AT_TOLERANCE_SEC, TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { z } from "zod";
import { type JournalEntry, journalEntrySchema } from "../../../src/meetings/lib/decision-journal";
import { itemLines } from "../../../src/meetings/lib/listen-answers";
import { OpenedMeeting } from "../../../src/meetings/lib/opened-meeting";
import { mergeMatcher } from "../../../src/meetings/lib/speaker-scores";
import { correctionsOf } from "../../../src/meetings/lib/transcript-corrections";

const args = parseArgs({
    options: {
        meeting: { type: "string", multiple: true },
        truth: { type: "string" },
        out: { type: "string" },
        pass: { type: "boolean", default: false },
        set: { type: "string", multiple: true },
        rows: { type: "boolean", default: false },
        labels: { type: "boolean", default: false },
        "as-is": { type: "boolean", default: false },
    },
}).values;

/** What the owner said beside the record: answers an agent relayed, the only people who spoke, people who never did. */
const extrasSchema = z.object({
    relayed: z.record(z.string(), z.array(z.string())).default({}),
    speakers: z.record(z.string(), z.array(z.string())).default({}),
    never: z.record(z.string(), z.array(z.string())).default({}),
    skip: z.array(z.string()).default([]),
});

type Range = Extract<MeetingItem, { kind: "speaker-range" }>;
type Shown = "plain" | "guess" | "unclear" | "unnamed" | "gone";

interface TruthLine {
    index: number;
    speaker: string;
    via: string;
    item?: string;
    rank: number;
    at: string;
}

interface Row {
    meeting: string;
    index: number;
    atSec?: number;
    label: string;
    shown: Shown;
    name?: string;
    truth?: string;
    via?: string;
    not?: string[];
    outcome?: string;
    winner?: { id: string; rules: string[]; confidence?: number; status: string; reason?: unknown; labeler?: unknown };
    ranges?: Array<Record<string, unknown>>;
    labels?: Record<string, unknown>;
}

const UNNAMED = /^(speaker|mluvčí|unknown|neznámý)[ _-]?\d*$/iu;

function scratchHome(): string {
    const home = env.get("GENESIS_TOOLS_HOME");
    if (!home) {
        throw new Error("Set GENESIS_TOOLS_HOME to a scratch copy: this benchmark never reads the user's own store.");
    }

    if (resolve(home) === resolve(homedir())) {
        throw new Error("GENESIS_TOOLS_HOME is the user's home; use a scratch copy.");
    }

    return home;
}

function readJournal(store: MeetingStore, id: string): JournalEntry[] {
    const file = join(store.folder(id), JOURNAL_FILE);
    if (!existsSync(file)) {
        return [];
    }

    return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .flatMap((line) => {
            const parsed = journalEntrySchema.safeParse(SafeJSON.parse(line));
            return parsed.success ? [parsed.data] : [];
        })
        .sort((a, b) => a.at.localeCompare(b.at));
}

function isRange(item: MeetingItem): item is Range {
    return item.kind === "speaker-range";
}

/** The truth of a meeting: per source line the person a person decided, and the people a person ruled out. */
function collectTruth(options: { record: MeetingRecord; lines: TranscriptLines; relayed: ReadonlySet<string> }): {
    truth: Map<number, TruthLine>;
    not: Map<number, string[]>;
    items: Set<string>;
    conflicts: number;
} {
    const { record, lines, relayed } = options;
    const found: TruthLine[] = [];
    const not = new Map<number, string[]>();
    const items = new Set<string>();

    for (const item of record.items) {
        if (!isRange(item) || !item.speaker || item.voices) {
            continue;
        }

        const actor = item.decision?.actor?.kind;
        const person = isPersonActor(actor) || relayed.has(item.id);
        const answered = item.rules.includes(MeetingRule.User);

        if (item.status === "rejected") {
            if (person) {
                items.add(item.id);
                for (const line of itemLines(item, lines)) {
                    not.set(line.index, [...(not.get(line.index) ?? []), item.speaker]);
                }
            }
            continue;
        }

        if (!(item.status === "confirmed" && person) && !answered) {
            continue;
        }

        items.add(item.id);
        const via =
            item.status === "confirmed" && person
                ? `confirmed:${relayed.has(item.id) ? "relayed" : actor}`
                : "user-answer";
        for (const line of itemLines(item, lines)) {
            found.push({
                index: line.index,
                speaker: item.speaker,
                via,
                item: item.id,
                rank: item.status === "confirmed" && person ? 2 : 1,
                at: item.decidedAt ?? item.suggestedAt ?? "",
            });
        }
    }

    for (const assignment of record.speakers.assignments ?? []) {
        const matched = lines
            .startingBetween(assignment.fromSec - LINE_AT_TOLERANCE_SEC, assignment.toSec + LINE_AT_TOLERANCE_SEC)
            .filter(({ entry }) => entry.speaker === assignment.label);
        for (const { index } of matched) {
            found.push({ index, speaker: assignment.person, via: "assignment", rank: 3, at: assignment.at });
        }
    }

    const truth = new Map<number, TruthLine>();
    let conflicts = 0;
    for (const line of found.sort((a, b) => a.rank - b.rank || a.at.localeCompare(b.at))) {
        const earlier = truth.get(line.index);
        if (earlier && !sameName(earlier.speaker, line.speaker)) {
            conflicts += 1;
        }
        truth.set(line.index, line);
    }

    for (const [index, names] of not) {
        const decided = truth.get(index);
        const left = names.filter((name) => !decided || !sameName(name, decided.speaker));
        if (left.length) {
            not.set(index, left);
        } else {
            not.delete(index);
        }
    }

    return { truth, not, items, conflicts };
}

/**
 * The record as it was before a person decided the truth items: each one is put back to the journal's "before" of
 * the person's decision, newest decision first; an item the decision made (or an agent added to carry a relayed
 * answer) is dropped; the person's assignments are removed. An item the journal does not cover falls back to the
 * decision's own "previous" (a suggestion), else it is dropped.
 */
function blindRecord(options: {
    record: MeetingRecord;
    items: ReadonlySet<string>;
    journal: readonly JournalEntry[];
    relayed: ReadonlySet<string>;
}): { record: MeetingRecord; restored: number; dropped: number; fallback: number } {
    const { items, relayed } = options;
    const record = structuredClone(options.record);
    let restored = 0;
    let dropped = 0;
    let fallback = 0;
    const settled = new Set<string>();
    const drop = (id: string) => {
        record.items = record.items.filter((item) => item.id !== id);
    };

    if (record.speakers.assignments?.length) {
        record.speakers.assignments = [];
    }

    for (const entry of [...options.journal].reverse()) {
        const personal = isPersonActor(entry.actor.kind) || entry.changes.some((change) => relayed.has(change.id));
        if (!personal) {
            continue;
        }

        for (const change of entry.changes) {
            const current = record.items.find((item) => item.id === change.id);
            if (!current) {
                continue;
            }

            const truthItem = items.has(change.id);
            if (!truthItem && !Bun.deepEquals(current, change.after)) {
                continue;
            }

            if (relayed.has(change.id) || !change.before) {
                drop(change.id);
                dropped += truthItem ? 1 : 0;
                settled.add(change.id);
                continue;
            }

            record.items[record.items.indexOf(current)] = structuredClone(change.before);
            if (truthItem && !settled.has(change.id)) {
                restored += 1;
                settled.add(change.id);
            }
        }
    }

    for (const id of items) {
        const item = record.items.find((one) => one.id === id);
        if (!item || !isRange(item)) {
            continue;
        }

        const decided =
            item.status !== "suggested" || item.rules.includes(MeetingRule.User) || item.decision !== undefined;
        if (!decided) {
            continue;
        }

        const previous = item.decision?.previous;
        if (previous?.status === "suggested" && !item.rules.includes(MeetingRule.User) && !relayed.has(id)) {
            const { decision: _decision, decidedAt: _decidedAt, ...rest } = item;
            const speaker = previous.speaker ?? ("speaker" in previous ? undefined : item.speaker);
            const { speaker: _speaker, ...unnamed } = rest;
            record.items[record.items.indexOf(item)] = {
                ...unnamed,
                ...(speaker ? { speaker } : {}),
                status: "suggested",
            };
            fallback += 1;
        } else {
            drop(id);
            dropped += 1;
        }
    }

    const ids = new Set(record.items.map((item) => item.id));
    record.items = record.items.flatMap((item): MeetingItem[] => {
        if (item.kind !== "question") {
            return [item];
        }

        const decides = item.decides.filter((id) => ids.has(id));
        return decides.length === 0 && item.decides.length > 0 ? [] : [{ ...item, decides }];
    });

    return { record, restored, dropped, fallback };
}

function setPath(raw: Record<string, unknown>, path: string, value: unknown): void {
    const keys = path.split(".");
    let node = raw;
    for (const key of keys.slice(0, -1)) {
        const next = node[key];
        if (typeof next !== "object" || next === null || Array.isArray(next)) {
            node[key] = {};
        }
        node = node[key] as Record<string, unknown>;
    }
    node[keys[keys.length - 1]!] = value;
}

const librarySchema = z.looseObject({
    samples: z
        .array(
            z.looseObject({
                meeting: z.string().optional(),
                source: z.looseObject({ rootMeeting: z.string().optional() }).optional(),
            })
        )
        .default([]),
});

/** Run `work` with this meeting's own samples left out of the scratch voice library, then put the library back. */
async function withoutOwnSamples<T>(store: MeetingStore, record: MeetingRecord, work: () => Promise<T>): Promise<T> {
    const libraryFile = join(store.root, "voice-library", "library.json");
    const saved = existsSync(libraryFile) ? readFileSync(libraryFile, "utf8") : undefined;
    try {
        if (saved !== undefined) {
            const library = librarySchema.parse(SafeJSON.parse(saved));
            const own = new Set([record.id, ...(record.join?.parts.map((part) => part.record) ?? [])]);
            library.samples = library.samples.filter(
                (sample) => !own.has(sample.meeting ?? "") && !own.has(sample.source?.rootMeeting ?? "")
            );
            writeFileSync(libraryFile, SafeJSON.stringify(library));
        }

        return await work();
    } finally {
        if (saved !== undefined) {
            writeFileSync(libraryFile, saved);
        }
    }
}

/**
 * Run the speakers pass on the scratch record. With `leaveOut`, the record is the blinded one and this meeting's own
 * samples are left out of the voice library.
 */
async function passOn(store: MeetingStore, blind: MeetingRecord, leaveOut: boolean): Promise<MeetingRecord> {
    const id = blind.id;
    const pass = async () => {
        const { runSuggest } = await import("../../../src/meetings/lib/suggest-run");
        await runSuggest({ store, record: store.read(id) ?? blind, rules: ["speakers"] });
    };

    if (leaveOut) {
        await store.update(id, { command: "benchmark", change: "leave the truth out" }, (current) => {
            current.items = blind.items;
            current.speakers = blind.speakers;
        });
        await withoutOwnSamples(store, blind, pass);
    } else {
        await pass();
    }

    return store.read(id) ?? blind;
}

/** What each labeler says about each line of the blinded record, and the line's channel and indicator readings. */
async function labelsOf(store: MeetingStore, blind: MeetingRecord): Promise<Map<number, Record<string, unknown>>> {
    const opened = OpenedMeeting.of(store, blind);
    const config = await opened.config();
    const settings = config.global.speakerLabels;
    const { proposeSpeakerLabels } = await import("../../../src/meetings/lib/speaker-labels");
    const { lineEvidence } = await import("@genesiscz/utils/transcribe/evidence");
    const byLine = new Map<number, Record<string, unknown>>();
    const at = (index: number) => {
        const row = byLine.get(index) ?? {};
        byLine.set(index, row);
        return row;
    };
    const seats = await proposeSpeakerLabels(opened, { ...settings, voice: { ...settings.voice, enabled: false } });
    for (const label of seats) {
        at(label.index).seat = { side: label.seat, person: label.person, score: label.score, reason: label.reason };
    }

    const voices = await withoutOwnSamples(store, blind, () =>
        proposeSpeakerLabels(opened, settings, undefined, { voiceOnly: true })
    );
    for (const label of voices) {
        at(label.index).voice = {
            person: label.person,
            score: label.score,
            reason: label.reason,
            margin: label.margin,
            next: label.next,
            support: label.voiceSupport,
        };
    }

    const meeting = await opened.meeting();
    const evidence = await opened.evidence();
    const energy = (await opened.energy()).share;
    const measured = lineEvidence(
        meeting.transcript,
        evidence ?? { segments: [], speaking: [] },
        await opened.presence(),
        energy
    );
    for (const line of measured) {
        at(line.index).line = {
            energyMic: line.energyMic ?? line.energyMicRaw,
            micShare: line.micShare,
            speaking: Object.keys(line.speaking),
            unknown: line.speakingUnknown,
            liveName: line.liveName,
        };
    }

    return byLine;
}

function compactRange(item: Range): Record<string, unknown> {
    const evidence = item.evidence ?? {};
    const support = evidence.voiceSupport as { score?: number; person?: string } | undefined;
    return {
        id: item.id,
        status: item.status,
        speaker: item.speaker,
        candidates: item.candidates,
        confidence: item.confidence,
        rules: item.rules,
        strength: rangeStrength(item),
        point: item.fromSec === item.toSec,
        labeler: evidence.labeler,
        reason: typeof evidence.reason === "string" && evidence.reason.length < 40 ? evidence.reason : undefined,
        seat: evidence.seat,
        score: evidence.score,
        support: support?.score,
        rival: evidence.next !== undefined,
        agreeing: evidence.agreeing,
        reviewOnly: evidence.reviewOnly,
        labelConflict: evidence.labelConflict,
        retired: evidence.retired,
    };
}

async function measure(options: {
    store: MeetingStore;
    record: MeetingRecord;
    extras: z.infer<typeof extrasSchema>;
    pass: boolean;
    rows: boolean;
    labels: boolean;
    asIs: boolean;
}) {
    const { store, extras } = options;
    const opened = OpenedMeeting.of(store, options.record);
    const meeting = await opened.meeting();
    const config: MeetingsConfig = await opened.config();
    const lines = new TranscriptLines(meeting.transcript);
    const relayed = new Set(extras.relayed[options.record.id] ?? []);
    const { truth, not, items, conflicts } = collectTruth({ record: options.record, lines, relayed });
    const blinded = options.asIs
        ? { record: options.record, restored: 0, dropped: 0, fallback: 0 }
        : blindRecord({ record: options.record, items, journal: readJournal(store, options.record.id), relayed });
    const record =
        options.pass && (options.asIs || truth.size > 0)
            ? await passOn(store, blinded.record, !options.asIs)
            : blinded.record;
    const corrections = correctionsOf(record, config, { withSuggested: true, format: "md" });
    const applied = applyCorrections(meeting.transcript, corrections);
    const unclearLabel = languageSettings(config).render.unclearLabel;
    const merged = mergeMatcher(opened.peopleMerges);
    const same = (a: string, b: string) => a.normalize("NFC") === b.normalize("NFC") || sameName(a, b) || merged(a, b);
    const byIndex = new Map<number, TranscriptEntry>();
    for (const entry of applied.entries) {
        const index = applied.sources.get(entry);
        if (index !== undefined) {
            byIndex.set(index, entry);
        }
    }

    const ranges = record.items.filter(isRange);
    const covering = (index: number, entry: TranscriptEntry) =>
        ranges.filter(
            (item) =>
                entry.startSec !== undefined &&
                entry.startSec >= item.fromSec &&
                entry.startSec <= item.toSec &&
                entry.speaker === item.label &&
                (item.fromSec !== item.toSec ||
                    typeof item.evidence?.transcriptLine !== "number" ||
                    item.evidence.transcriptLine === index)
        );
    const allowed = extras.speakers[record.id];
    const never = extras.never[record.id] ?? [];
    const counts: Record<string, number> = {};
    const add = (key: string) => {
        counts[key] = (counts[key] ?? 0) + 1;
    };
    const rows: Row[] = [];
    const labels = options.labels && truth.size > 0 ? await labelsOf(store, record) : undefined;

    for (const [index, source] of meeting.transcript.entries()) {
        if (!source.text.trim()) {
            continue;
        }

        const entry = byIndex.get(index);
        let shown: Shown = "gone";
        let name: string | undefined;

        if (entry) {
            const guess = applied.guessed.get(entry);
            if (isUnclearMarker(entry.speaker, unclearLabel)) {
                shown = "unclear";
            } else if (guess !== undefined) {
                shown = "guess";
                name = guess;
            } else if (UNNAMED.test(entry.speaker.trim())) {
                shown = "unnamed";
            } else {
                shown = "plain";
                name = entry.speaker;
            }
        }

        add(`all.${shown}`);
        const decided = truth.get(index);
        const ruledOut = [...(not.get(index) ?? []), ...never];
        let outcome: string | undefined;

        if (decided && shown !== "gone") {
            outcome =
                shown === "plain" || shown === "guess"
                    ? `${shown}-${same(name!, decided.speaker) ? "correct" : "wrong"}`
                    : shown;
            add(`truth.${outcome}`);
            add(`via.${decided.via}`);
        } else if (decided) {
            add("truth.gone");
        }

        if (!decided && name !== undefined && ruledOut.some((person) => same(person, name!))) {
            add(`ruledOut.${shown}`);
            outcome = `${shown}-ruled-out`;
        }

        if (allowed && name !== undefined && !allowed.some((person) => same(person, name!))) {
            add(`outsideSpeakers.${shown}`);
            outcome ??= `${shown}-outside`;
        }

        if (options.rows) {
            const covered = covering(index, source);
            const winner = strongestRange(covered.filter((item) => item.status !== "rejected"));
            rows.push({
                meeting: record.id,
                index,
                atSec: source.startSec,
                label: source.speaker,
                shown,
                ...(name === undefined ? {} : { name }),
                ...(decided ? { truth: decided.speaker, via: decided.via } : {}),
                ...(ruledOut.length ? { not: ruledOut } : {}),
                ...(outcome ? { outcome } : {}),
                ...(winner
                    ? {
                          winner: {
                              id: winner.id,
                              rules: winner.rules,
                              confidence: winner.confidence,
                              status: winner.status,
                              reason: winner.evidence?.reason,
                              labeler: winner.evidence?.labeler,
                          },
                      }
                    : {}),
                ranges: covered.map(compactRange),
                ...(labels?.has(index) ? { labels: labels.get(index) } : {}),
            });
        }
    }

    return {
        meeting: record.id,
        truthLines: truth.size,
        truthItems: items.size,
        ruledOutLines: not.size,
        conflicts,
        restored: blinded.restored,
        dropped: blinded.dropped,
        fallback: blinded.fallback,
        counts,
        rows,
    };
}

const home = scratchHome();
if (!args.out) {
    throw new Error("Missing --out");
}

const extras = extrasSchema.parse(args.truth ? SafeJSON.parse(readFileSync(args.truth, "utf8")) : {});
if (args.set?.length) {
    await new MeetingsConfigStore().update((raw) => {
        for (const pair of args.set ?? []) {
            const at = pair.indexOf("=");
            setPath(raw, pair.slice(0, at), SafeJSON.parse(pair.slice(at + 1)));
        }
    });
}

const store = new MeetingStore();
const wanted = new Set(args.meeting ?? []);
const results: Awaited<ReturnType<typeof measure>>[] = [];
const failed: Array<{ meeting: string; error: string }> = [];

for (const record of store.list()) {
    if ((wanted.size > 0 && !wanted.has(record.id)) || extras.skip.includes(record.id)) {
        continue;
    }

    try {
        results.push(
            await measure({
                store,
                record,
                extras,
                pass: args.pass,
                rows: args.rows,
                labels: args.labels,
                asIs: args["as-is"],
            })
        );
    } catch (error) {
        failed.push({ meeting: record.id, error: error instanceof Error ? error.message : String(error) });
    }
}

const total: Record<string, number> = {};
for (const result of results) {
    for (const [key, value] of Object.entries(result.counts)) {
        total[key] = (total[key] ?? 0) + value;
    }
}

const withTruth = results.filter((result) => result.truthLines > 0);
const report = {
    home,
    pass: args.pass,
    set: args.set ?? [],
    meetings: results.length,
    meetingsWithTruth: withTruth.length,
    truthLines: withTruth.reduce((sum, result) => sum + result.truthLines, 0),
    total,
    failed,
    results,
};
writeFileSync(resolve(args.out), SafeJSON.stringify(report, null, 1), { mode: 0o600 });
out.print(
    `${SafeJSON.stringify({ meetings: report.meetings, meetingsWithTruth: report.meetingsWithTruth, truthLines: report.truthLines, total, failed })}\n`
);
