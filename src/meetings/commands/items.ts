import { readFileSync } from "node:fs";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { parseDuration } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { renderFrontmatter } from "@genesiscz/utils/json2md/frontmatter";
import { logger, out } from "@genesiscz/utils/logger";
import { MeetingsConfigStore, resolveDictionary } from "@genesiscz/utils/meetings/config";
import { appendCorrections, type Correction } from "@genesiscz/utils/meetings/corrections";
import {
    ITEM_STATUSES,
    type MeetingItem,
    type MeetingRecord,
    MeetingStore,
    QUESTION_TOPICS,
} from "@genesiscz/utils/meetings/record";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import { applyCorrections } from "@genesiscz/utils/transcribe/apply";
import type { WordCheck } from "@genesiscz/utils/transcribe/languages/word-check";
import {
    entriesToSrt,
    entriesToVtt,
    formatClock,
    groupTurns,
    localTime,
    TRANSCRIPT_FORMATS,
    transcriptMarkdown,
    transcriptTextLines,
} from "@genesiscz/utils/transcribe/render";
import { DEFAULT_SPAN_GAP_SEC, speakerStats } from "@genesiscz/utils/transcribe/speakers";
import { summaryPoints } from "@genesiscz/utils/transcribe/summary";
import type { Command } from "commander";
import pc from "picocolors";
import { z } from "zod";
import { collectAndReport } from "../lib/collect";
import { energyMicShareFor } from "../lib/energy";
import { FINDING_KINDS, findingItems, findingProblem, findingSchema, findingsFileSchema } from "../lib/findings";
import { speakingEvidence } from "../lib/platforms";
import { presenceFor } from "../lib/presence";
import { errorText, fail, resolveEnum, TOOL } from "../lib/shared";
import { linkedSource } from "../lib/sources";
import { printSpeakerStats } from "../lib/speakers-view";
import { isSuggestRule, SUGGEST_RULES, suggestItems } from "../lib/suggest";
import { correctionsOf } from "../lib/transcript-corrections";
import { DEFAULT_WORD_CHECK, WORD_CHECKS, type WordCheckChoice, wordCheckFor } from "../lib/word-check";

const { log } = logger.scoped("meetings-items");

const MEETING_REF = "meeting id, a unique prefix, last, or wisprflow:<id>";

function requireMeeting(store: MeetingStore, ref: string): MeetingRecord | undefined {
    try {
        const record = store.resolve(ref);

        if (!record) {
            fail(`No meeting "${ref}". List them: ${TOOL} list`);
        }

        return record;
    } catch (err) {
        fail(errorText(err));
        return undefined;
    }
}

async function loadTranscript(record: MeetingRecord): Promise<SourceMeeting> {
    const { source, sourceMeetingId } = await linkedSource(record);
    log.debug({ meeting: record.id, source: source.id, sourceMeetingId }, "loading transcript");
    return source.load(sourceMeetingId);
}

function itemWhat(item: MeetingItem): string {
    if (item.kind === "speaker-range") {
        const who = item.speaker ?? `? (${item.candidates?.join(", ") || "unknown"})`;
        return `${item.label} ${formatClock(item.fromSec)}–${formatClock(item.toSec)} → ${who}`;
    }

    if (item.kind === "join") {
        return `${formatClock(item.atSec)} "${item.joined ?? ""}"${item.speaker ? ` → ${item.speaker}` : ""}`;
    }

    if (item.kind === "question") {
        const range = `${formatClock(item.fromSec)}–${formatClock(item.toSec)}`;
        const said = item.answer ? `→ ${item.answer}` : item.choices.length > 0 ? `(${item.choices.join(" / ")})` : "";
        return `${range} ${item.question} ${said}`.trim();
    }

    const occurrences = typeof item.evidence?.occurrences === "number" ? ` ×${item.evidence.occurrences}` : "";
    return `${item.heard} → ${item.proposed ?? "?"}${occurrences}`;
}

const STATUS_COLOR: Record<MeetingItem["status"], (text: string) => string> = {
    suggested: pc.yellow,
    confirmed: pc.green,
    rejected: pc.dim,
};

function printItems(items: MeetingItem[]): void {
    const table = createBoxTable(["ID", "KIND", "STATUS", "CONF", "WHAT", "RULES"]);

    for (const item of items) {
        table.push([
            pc.white(item.id),
            item.kind,
            STATUS_COLOR[item.status](item.status),
            item.confidence === undefined ? "—" : `${Math.round(item.confidence * 100)} %`,
            truncateDisplay(itemWhat(item), 90),
            item.rules.join(", "),
        ]);
    }

    out.println(table.toString());
}

/** The word check for the term rules, or undefined when it is off or cannot run (said once, with the reason). */
async function termWordCheck(choice: WordCheckChoice, meeting: SourceMeeting): Promise<WordCheck | undefined> {
    const opened = await wordCheckFor(choice, meeting.transcript);

    if (!opened.check && choice !== "off") {
        ui.warn(`The word check is off (${opened.reason}); the term rules skip every word with a Czech letter.`);
    }

    return opened.check;
}

async function suggest(
    ref: string,
    opts: { rules?: string; attendance?: string; wordCheck?: string; json?: boolean }
): Promise<void> {
    const store = new MeetingStore();
    const record = requireMeeting(store, ref);

    if (!record) {
        return;
    }

    const asked = (opts.rules ?? SUGGEST_RULES.join(",")).split(",").map((rule) => rule.trim());
    const rules = asked.filter(isSuggestRule);
    const unknown = asked.filter((rule) => !isSuggestRule(rule));

    if (unknown.length > 0) {
        fail(`Unknown rule set ${unknown.join(", ")}. Known: ${SUGGEST_RULES.join(", ")}`);
        return;
    }

    const wordCheckChoice = await resolveEnum({
        value: opts.wordCheck,
        fallback: DEFAULT_WORD_CHECK,
        values: WORD_CHECKS,
        flag: "--word-check",
        subcommand: ["suggest"],
    });

    if (!wordCheckChoice) {
        return;
    }

    try {
        // The platform, attendance and channel layout first, when the record lacks any of them.
        const collected =
            record.platform && record.attendance && record.evidence?.channels
                ? record
                : await collectAndReport(store, record);
        const { source, sourceMeetingId } = await linkedSource(collected);
        const meeting = await source.load(sourceMeetingId);
        const config = await new MeetingsConfigStore().read();
        const evidence = rules.includes("evidence")
            ? speakingEvidence(collected, await source.evidence(sourceMeetingId))
            : null;
        const wordCheck = rules.includes("terms") ? await termWordCheck(wordCheckChoice, meeting) : undefined;
        const fresh = suggestItems({
            record: collected,
            meeting,
            rules,
            dictionary: resolveDictionary(config, { project: record.project, meeting: record.dictionary }),
            sourceWords: await source.dictionary(),
            presence: await presenceFor(collected, meeting, opts.attendance),
            evidence,
            energyMicShare: (await energyMicShareFor(store, collected, evidence)).share,
            listenBelow: config.global.suggest.listenBelow,
            questionBudget: config.global.playback.listen.budget,
            minPriority: config.global.playback.listen.minPriority,
            points: meeting.summary ? summaryPoints(meeting.summary, config.global.summary) : [],
            wordCheck,
            now: new Date().toISOString(),
        });
        wordCheck?.dispose();

        if (fresh.length > 0) {
            await store.update(
                record.id,
                { command: "suggest", change: `${fresh.length} items (${fresh[0]!.id} to ${fresh.at(-1)!.id})` },
                (current) => {
                    current.items.push(...fresh);
                }
            );
        }

        if (opts.json) {
            out.result(SafeJSON.stringify(fresh, null, 2));
            return;
        }

        if (fresh.length === 0) {
            ui.info("Nothing new to suggest.");
            return;
        }

        printItems(fresh);
        ui.dim(`Confirm or reject: ${TOOL} confirm ${record.id} <ids> · ${TOOL} reject ${record.id} <ids>`);
    } catch (err) {
        fail(errorText(err));
    }
}

async function items(ref: string, opts: { status?: string | boolean; kind?: string; json?: boolean }): Promise<void> {
    const record = requireMeeting(new MeetingStore(), ref);

    if (!record) {
        return;
    }

    const status =
        opts.status === undefined
            ? undefined
            : await resolveEnum({ value: opts.status, values: ITEM_STATUSES, flag: "--status", subcommand: ["items"] });

    if (opts.status !== undefined && !status) {
        return;
    }

    const listed = record.items.filter(
        (item) => (!status || item.status === status) && (!opts.kind || item.kind === opts.kind)
    );

    if (opts.json) {
        out.result(SafeJSON.stringify(listed, null, 2));
        return;
    }

    if (listed.length === 0) {
        ui.info(`No items. Suggest some: ${TOOL} suggest ${record.id}`);
        return;
    }

    printItems(listed);
}

interface AddOptions {
    kind?: string;
    listen?: boolean;
    fromFile?: string;
    from?: string;
    to?: string;
    at?: string;
    label?: string;
    speaker?: string;
    heard?: string;
    proposed?: string;
    about?: string;
    question?: string;
    choices?: string;
    decides?: string;
    confidence?: string;
    reason?: string;
}

function commaList(value: string | undefined): string[] | undefined {
    return value === undefined
        ? undefined
        : value
              .split(",")
              .map((part) => part.trim())
              .filter(Boolean);
}

/** The finding the flags describe, in the shape a `--from-file` entry has, before validation. */
function findingFromFlags(opts: AddOptions): Record<string, unknown> {
    const kind = opts.listen ? "question" : (opts.kind ?? "question");
    const fields: Record<string, unknown> = {
        kind,
        from: opts.from,
        to: opts.to,
        at: opts.at,
        label: opts.label,
        speaker: opts.speaker,
        heard: opts.heard,
        proposed: opts.proposed,
        about: opts.about,
        question: opts.question,
        choices: commaList(opts.choices),
        decides: commaList(opts.decides),
        confidence: opts.confidence === undefined ? undefined : Number(opts.confidence),
        reason: opts.reason,
    };
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/**
 * `items add`: an agent's finding (a speaker range or a term, with a confidence and a reason) or a question to answer
 * by ear. `--from-file` adds a whole batch in one write; a batch with one bad entry adds nothing.
 */
async function addItems(ref: string, own: AddOptions, command: Command): Promise<void> {
    // The parent `items` has a `--kind` filter of its own, and Commander gives a shared flag to the parent.
    const parentKind = command.parent?.opts<{ kind?: string }>().kind;
    const opts: AddOptions = { ...own, ...(own.kind === undefined && parentKind ? { kind: parentKind } : {}) };
    const store = new MeetingStore();
    const record = requireMeeting(store, ref);

    if (!record) {
        return;
    }

    let raw: unknown;

    try {
        raw = opts.fromFile
            ? SafeJSON.parse(readFileSync(opts.fromFile, "utf8"), { strict: true })
            : [findingFromFlags(opts)];
    } catch (err) {
        fail(`--from-file ${opts.fromFile}: ${errorText(err)}`);
        return;
    }

    const parsed = findingsFileSchema.safeParse(raw);

    if (!parsed.success) {
        // The union's own message says only "Invalid input"; the entries' schema names the field.
        const entries = Array.isArray(raw) ? raw : [raw];
        const issue = z.array(findingSchema).safeParse(entries).error?.issues[0] ?? parsed.error.issues[0];
        const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
        fail(`Not a finding${where}: ${issue?.message ?? "invalid"}. Kinds: ${FINDING_KINDS.join(", ")}.`);
        return;
    }

    const problems = parsed.data.flatMap((finding, index) => {
        const problem = findingProblem(finding, record.items);
        return problem ? [`#${index + 1} (${finding.kind}) ${problem}`] : [];
    });

    if (problems.length > 0) {
        fail(`Nothing added: ${problems.join("; ")}`);
        return;
    }

    try {
        let added: MeetingItem[] = [];
        await store.update(record.id, { command: "items add", change: `${parsed.data.length} findings` }, (current) => {
            added = findingItems(parsed.data, current.items, new Date().toISOString());
            current.items.push(...added);
        });

        if (added.length === 1 && added[0]!.kind === "question") {
            ui.ok(
                `${added[0]!.id} added to ${record.id}. Answer it: ${TOOL} listen ${record.id} --item ${added[0]!.id}`
            );
            return;
        }

        ui.ok(
            added.length === 1
                ? `${added[0]!.id} added to ${record.id}.`
                : `${added.length} items added to ${record.id} (${added[0]?.id} to ${added.at(-1)?.id}).`
        );
    } catch (err) {
        fail(errorText(err));
    }
}

/** Picks the items a decision names: ids, or every suggested item at or above a confidence. */
function pickItems(record: MeetingRecord, ids: string[], minConfidence?: number): MeetingItem[] | string {
    if (minConfidence !== undefined) {
        return record.items.filter((item) => item.status === "suggested" && (item.confidence ?? 0) >= minConfidence);
    }

    const missing = ids.filter((id) => !record.items.some((item) => item.id === id));

    if (missing.length > 0) {
        return `${record.id} has no item ${missing.join(", ")} (${TOOL} items ${record.id})`;
    }

    return record.items.filter((item) => ids.includes(item.id));
}

async function decide(
    status: "confirmed" | "rejected",
    ref: string,
    ids: string[],
    opts: { speaker?: string; proposed?: string; minConfidence?: string }
): Promise<void> {
    const store = new MeetingStore();
    const record = requireMeeting(store, ref);

    if (!record) {
        return;
    }

    const minConfidence = opts.minConfidence === undefined ? undefined : Number(opts.minConfidence);

    if (minConfidence !== undefined && !(minConfidence >= 0 && minConfidence <= 1)) {
        fail(`--min-confidence ${opts.minConfidence} must be between 0 and 1 (0.8 = 80 %).`);
        return;
    }

    if (ids.length === 0 && minConfidence === undefined) {
        fail(`Name the items (i1 i2 …) or give --min-confidence <0..1>.`);
        return;
    }

    const picked = pickItems(record, ids, minConfidence);

    if (typeof picked === "string") {
        fail(picked);
        return;
    }

    // A range nobody named, or a term with no spelling, cannot be applied: confirming needs --speaker or --proposed.
    const unnamed =
        status === "confirmed"
            ? picked.filter(
                  (item) =>
                      (item.kind === "speaker-range" && !item.speaker && !opts.speaker) ||
                      (item.kind === "term" && !item.proposed && !opts.proposed)
              )
            : [];
    // A question is answered by ear, which also decides the items it names.
    const questions: MeetingItem[] = status === "confirmed" ? picked.filter((item) => item.kind === "question") : [];

    for (const item of questions) {
        ui.warn(`${item.id} is a question; answer it: ${TOOL} listen ${record.id} --item ${item.id}`);
    }

    const deciding = picked.filter((item) => !unnamed.includes(item) && !questions.includes(item));

    for (const item of unnamed) {
        const candidates =
            item.kind === "speaker-range" && item.candidates?.length
                ? ` Candidates: ${item.candidates.join(", ")}.`
                : "";
        ui.warn(
            item.kind === "term"
                ? `${item.id} ("${item.heard}") has no spelling yet; confirm it with --proposed <text>.`
                : `${item.id} has no speaker yet; confirm it with --speaker <name>.${candidates}`
        );
    }

    if (deciding.length === 0) {
        process.exitCode = unnamed.length + questions.length > 0 ? 1 : 0;
        return;
    }

    const now = new Date().toISOString();
    const ledger: Correction[] = [];

    try {
        await store.update(
            record.id,
            {
                command: status === "confirmed" ? "confirm" : "reject",
                change: deciding.map((item) => item.id).join(" "),
            },
            (current) => {
                for (const item of current.items) {
                    if (!deciding.some((picked) => picked.id === item.id)) {
                        continue;
                    }

                    item.status = status;
                    item.decidedAt = now;

                    if (status !== "confirmed") {
                        continue;
                    }

                    if (item.kind === "speaker-range" && opts.speaker) {
                        item.speaker = opts.speaker;
                    }

                    if (item.kind === "term") {
                        const fixed = opts.proposed ?? item.proposed;

                        if (!fixed) {
                            continue;
                        }

                        item.proposed = fixed;
                        ledger.push({
                            at: now,
                            meeting: current.id,
                            project: current.project,
                            kind: "term",
                            heard: item.heard,
                            fixed,
                            item: item.id,
                        });
                    }

                    if (item.kind === "join" && item.joined) {
                        const evidence = item.evidence ?? {};
                        const heard = [evidence.left, evidence.right]
                            .filter((part) => typeof part === "string")
                            .join(" ");
                        ledger.push({
                            at: now,
                            meeting: current.id,
                            project: current.project,
                            kind: "join",
                            heard,
                            fixed: item.joined,
                            item: item.id,
                        });
                    }
                }
            }
        );
        appendCorrections(ledger);
        ui.ok(`${status} ${deciding.map((item) => item.id).join(" ")} in ${record.id}`);
    } catch (err) {
        fail(errorText(err));
    }
}

async function speakersStats(ref: string, opts: { gap?: string; attendance?: string; json?: boolean }): Promise<void> {
    const record = requireMeeting(new MeetingStore(), ref);

    if (!record) {
        return;
    }

    const gapSec = opts.gap === undefined ? DEFAULT_SPAN_GAP_SEC : parseDuration(opts.gap) / 1000;

    if (!(gapSec > 0)) {
        fail(`--gap ${opts.gap} is not a duration (try 90s or 2m).`);
        return;
    }

    try {
        const meeting = await loadTranscript(record);
        const stats = speakerStats(meeting.transcript, {
            gapSec,
            participants: meeting.speakers,
            presence: await presenceFor(record, meeting, opts.attendance),
        });

        if (opts.json) {
            out.result(SafeJSON.stringify({ meeting: record.id, gapSec, ...stats }, null, 2));
            return;
        }

        printSpeakerStats(stats);
    } catch (err) {
        fail(errorText(err));
    }
}

async function speakersRename(ref: string, label: string, name: string): Promise<void> {
    const store = new MeetingStore();
    const record = requireMeeting(store, ref);

    if (!record) {
        return;
    }

    try {
        await store.update(record.id, { command: "speakers rename", change: `${label} → ${name}` }, (current) => {
            current.speakers.labels[label] = name;
        });
        ui.ok(`${record.id}: ${label} → ${name} (transcripts of this meeting use it now)`);
    } catch (err) {
        fail(errorText(err));
    }
}

async function transcript(
    ref: string,
    opts: {
        format?: string | boolean;
        withSuggested?: boolean;
        dictionary?: boolean;
        timestamps?: boolean;
        frontmatter?: boolean;
    }
): Promise<void> {
    const record = requireMeeting(new MeetingStore(), ref);
    const format = await resolveEnum({
        value: opts.format,
        fallback: "md",
        values: TRANSCRIPT_FORMATS,
        flag: "--format",
        subcommand: ["transcript"],
    });

    if (!record || !format) {
        return;
    }

    try {
        const meeting = await loadTranscript(record);
        const config = await new MeetingsConfigStore().read();
        const applied = applyCorrections(meeting.transcript, correctionsOf(record, config, { ...opts, format }));
        ui.dim(
            `applied: ${applied.labels} renamed lines, ${applied.ranges} re-attributed, ${applied.joins} joins, ${applied.terms} term fixes, ${applied.fixes} dictionary fixes, ${applied.spoken} spoken forms, ${applied.fuzzy} fuzzy, ${applied.expansions} expansions, ${applied.meanings} meanings, ${applied.unclear} unclear marks`
        );

        if (format === "json") {
            out.result(SafeJSON.stringify({ meeting: record.id, entries: applied.entries }, null, 2));
            return;
        }

        if (format === "srt" || format === "vtt") {
            out.print(format === "srt" ? entriesToSrt(applied.entries) : entriesToVtt(applied.entries));
            return;
        }

        const turns = groupTurns(applied.entries);

        if (format === "txt") {
            out.print(
                `${[record.title, localTime(record.start), "", ...transcriptTextLines(turns, opts.timestamps === true)].join("\n").trimEnd()}\n`
            );
            return;
        }

        const parts: string[] = [];

        if (opts.frontmatter !== false) {
            parts.push(
                renderFrontmatter({
                    title: record.title,
                    meeting: localTime(record.start),
                    ...(record.project ? { project: record.project } : {}),
                    meeting_id: record.id,
                    sources: Object.keys(record.sources),
                    // An open speaker mark is not a speaker.
                    speakers: [
                        ...new Set(
                            applied.entries
                                .map((entry) => entry.speaker)
                                .filter((name) => !name.startsWith(`[${config.global.render.unclearLabel}:`))
                        ),
                    ],
                })
            );
        }

        parts.push(`# ${record.title || "Untitled meeting"}`, transcriptMarkdown(turns, opts.timestamps === true));
        out.print(`${parts.join("\n\n")}\n`);
    } catch (err) {
        fail(errorText(err));
    }
}

export function registerItemCommands(program: Command): void {
    program
        .command("suggest")
        .argument("<meeting>", MEETING_REF)
        .description("Run the rules on the meeting's transcript and add what they find as suggested items")
        .option("--rules <list>", `which rule sets: ${SUGGEST_RULES.join(",")} (default all)`)
        .option("--attendance <teams|file>", "who was in the call and when (Teams), for rule RA")
        .option(
            "--word-check <provider>",
            `${WORD_CHECKS.join(" | ")}: tells ordinary Czech words from unknown ones for the term rules; the dictionaries download on first use (default ${DEFAULT_WORD_CHECK})`
        )
        .option("--json", "print the new items")
        .action(suggest);

    program
        .command("items")
        .argument("<meeting>", MEETING_REF)
        .description("The meeting's items with their status, confidence and rules")
        .option("--status [status]", ITEM_STATUSES.join(" | "))
        .option("--kind <kind>", "speaker-range | join | term | question")
        .option("--json", "print JSON")
        .action(items)
        .command("add")
        .argument("<meeting>", MEETING_REF)
        .description(
            `Add an agent's finding (a speaker range or a term, with a confidence and a reason) or a question for ${toolCommand("meetings", "listen")}`
        )
        .option("--kind <kind>", `${FINDING_KINDS.join(" | ")} (default question)`)
        .option("--listen", "same as --kind question")
        .option("--from-file <json>", "a batch: an array of findings in the shape the flags make (see the README)")
        .option("--from <time>", "range start: 37:43, 1:02:10 or seconds (speaker-range, question)")
        .option("--to <time>", "range end (speaker-range, question)")
        .option("--at <time>", "term: where it is heard")
        .option("--label <label>", "speaker-range: the source's label of those lines")
        .option("--speaker <name>", "speaker-range: who it really is")
        .option(
            "--heard <words>",
            "term: the words as the transcript has them; question: the words marked until answered"
        )
        .option("--proposed <text>", "term: the right spelling, when known")
        .option("--about [topic]", `question: ${QUESTION_TOPICS.join(" | ")} (default speaker)`)
        .option("--question <text>", "question: what to decide, as the listener reads it")
        .option("--choices <list>", "question: comma-separated answers to offer")
        .option("--decides <ids>", "question: comma-separated items the answer confirms or rejects")
        .option("--confidence <0..1>", "how sure the finding is (required for speaker-range and term)")
        .option("--reason <text>", "why: the facts and context it rests on (required for speaker-range and term)")
        .action(addItems);

    for (const [name, status] of [
        ["confirm", "confirmed"],
        ["reject", "rejected"],
    ] as const) {
        program
            .command(name)
            .argument("<meeting>", MEETING_REF)
            .argument("[items...]", "item ids: i1 i2 …")
            .description(
                status === "confirmed"
                    ? "Confirm items: transcripts apply confirmed items"
                    : "Reject items: they are never suggested again"
            )
            .option("--min-confidence <0..1>", "every suggested item at or above this confidence")
            .option("--speaker <name>", "confirm: whose voice a speaker range is")
            .option("--proposed <text>", "confirm: the right spelling of a term, when the proposal is wrong")
            .action(
                (ref: string, ids: string[], opts: { speaker?: string; proposed?: string; minConfidence?: string }) =>
                    decide(status, ref, ids, opts)
            );
    }

    const speakers = program.command("speakers").description("The meeting's speakers: statistics, hints and renames");

    speakers
        .command("stats")
        .argument("<meeting>", MEETING_REF)
        .description("Per label: origin, turns, spoken time and spans, with hints")
        .option("--gap <duration>", "a pause shorter than this keeps two turns in one span", "2m")
        .option("--attendance <teams|file>", "who was in the call and when (Teams)")
        .option("--json", "print JSON")
        .action(speakersStats);

    speakers
        .command("rename")
        .argument("<meeting>", MEETING_REF)
        .argument("<label>", "the source's label, as the transcript shows it")
        .argument("<name>", "the right name")
        .description("Rename a label for this meeting")
        .action(speakersRename);

    program
        .command("transcript")
        .argument("<meeting>", MEETING_REF)
        .description("The transcript with renames, confirmed items and the dictionary applied")
        .option("--format [format]", `${TRANSCRIPT_FORMATS.join(" | ")} (default md)`)
        .option("--with-suggested", "also apply the suggested items")
        .option("--no-dictionary", "do not apply the dictionary")
        .option("--no-frontmatter", "md: omit the frontmatter")
        .option("--timestamps", "show the start time of each paragraph")
        .action(transcript);
}
